// Relative imports: reachable from `server.ts` (via `background.ts`), which
// `build:server` compiles with plain tsc -- the `@/` alias would be emitted verbatim.
import { db } from "./db"
import { logger } from "./logger"
import { moderateBlurPhoto, moderateProfilePhoto, pullPhoto } from "./photos"
import { objectPresence, ownedPhotoKey } from "./tigris"

/**
 * Photos the vendor could not look at get looked at again (SCRUM-732).
 *
 * `photo_checks.checked = false` means "the moderation call could not run" and
 * the schema promised a sweeper would revisit those rows. None did: a photo
 * whose one check failed (OpenAI could not download a freshly written object,
 * an outage, a timeout) stayed public and unmoderated for the life of the row.
 *
 * What a never-checked photo shows meanwhile is unchanged: it is shown. Hiding
 * every unchecked photo would blank profiles for the length of any vendor
 * outage, and the failure it covers is overwhelmingly transient; this closes
 * the gap in minutes instead, and a photo found unsafe on the second look is
 * pulled exactly as the first look would have pulled it. The exception fails
 * closed: a URL on a profile that is not the person's own object can never be
 * judged (it is never sent to the vendor), so it is pulled.
 *
 * The verdict goes through the functions the profile write already uses
 * (`moderateProfilePhoto`, `moderateBlurPhoto`, `pullPhoto`), so a pass, a
 * pull and the 180-day hold mean one thing wherever the verdict comes from.
 *
 * ## Why one person cannot starve the queue
 *
 * A pass takes the least recently attempted rows first, at most
 * `PER_USER_SLOTS` per person, and stamps each row it takes before asking the
 * vendor. A pile of photos that never get a verdict rotates behind the ones
 * that might; past `MAX_ATTEMPTS_PER_DAY_AFTER` tries a row is retried once a
 * day, not every pass.
 */
export const SWEEP_INTERVAL_MS = 10 * 60 * 1000
/** The write that made the row runs its own check after the response; give it time to finish first. */
export const SWEEP_SETTLE_MS = 2 * 60 * 1000
const BATCH_LIMIT = 25
export const PER_USER_SLOTS = 3
/** Candidates read per pass, from which the per-person cap is applied. */
const POOL = BATCH_LIMIT * 8
/** ~8 hours of passes. After this a row is a standing problem for an operator, not a retry. */
export const MAX_ATTEMPTS_PER_DAY_AFTER = 48
const BACKOFF_MS = 24 * 60 * 60 * 1000

export interface PhotoSweepResult {
  /** Rows taken this pass. */
  looked: number
  /** Rows no longer on the unchecked list: checked, pulled, or dropped because the object is gone. */
  settled: number
}

export async function sweepUnmoderatedPhotos(now: Date = new Date()): Promise<PhotoSweepResult> {
  const pool = await db.photo_checks.findMany({
    where: {
      checked: false,
      created_at: { lt: new Date(now.getTime() - SWEEP_SETTLE_MS) },
      OR: [
        { attempts: { lt: MAX_ATTEMPTS_PER_DAY_AFTER } },
        { last_attempted_at: null },
        { last_attempted_at: { lt: new Date(now.getTime() - BACKOFF_MS) } },
      ],
    },
    orderBy: [{ last_attempted_at: { sort: "asc", nulls: "first" } }, { created_at: "asc" }],
    take: POOL,
    select: { url: true, user_id: true },
  })

  const perUser = new Map<string, number>()
  const rows = pool
    .filter((r) => {
      const n = perUser.get(r.user_id) ?? 0
      perUser.set(r.user_id, n + 1)
      return n < PER_USER_SLOTS
    })
    .slice(0, BATCH_LIMIT)

  for (const { url, user_id: userId } of rows) {
    try {
      // Stamped first: a row that throws, or hangs the process, still goes to the back.
      const { attempts } = await db.photo_checks.update({
        where: { url },
        data: { attempts: { increment: 1 }, last_attempted_at: now },
        select: { attempts: true },
      })
      if (attempts === MAX_ATTEMPTS_PER_DAY_AFTER) {
        logger.error("Photo still unjudged after many attempts; retried daily from here", { userId, attempts })
      }
      await recheck(url, userId)
    } catch (error) {
      logger.error("Unchecked photo sweep failed for one photo", {
        userId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const stillUnchecked = rows.length
    ? await db.photo_checks.count({ where: { url: { in: rows.map((r) => r.url) }, checked: false } })
    : 0
  return { looked: rows.length, settled: rows.length - stillUnchecked }
}

async function recheck(url: string, userId: string): Promise<void> {
  // The SSRF gate, again: this URL goes to a vendor that fetches it. A URL that
  // fails it can never be judged, so it does not stay on the profile unjudged.
  const key = ownedPhotoKey(url, userId)
  if (!key) {
    logger.warn("Unchecked photo is not the person's own object; pulled", { userId })
    await pullPhoto(url, userId)
    return
  }
  const profile = await db.profiles.findUnique({ where: { id: userId }, select: { photos: true, blur_photo: true } })
  const onProfile = Boolean(profile && (profile.photos.includes(url) || profile.blur_photo === url))

  const presence = await objectPresence(key)
  // Anything but a confirmed 404 -- the network, a 5xx, a permissions error -- is "could not tell": next pass.
  if (presence === "unknown") return
  if (presence === "gone") {
    // Nothing left to moderate, if nothing points at it. One the profile still points at is not
    // a judged photo, so its row stays on the list.
    if (!onProfile) await db.photo_checks.deleteMany({ where: { url, checked: false } })
    return
  }
  if (profile?.blur_photo === url) await moderateBlurPhoto(url, userId)
  else await moderateProfilePhoto(url, userId)
}

let timer: ReturnType<typeof setTimeout> | null = null
let stopped = false

async function runSweep(): Promise<void> {
  try {
    const { looked, settled } = await sweepUnmoderatedPhotos()
    if (looked > 0) logger.info("Unchecked photo sweep", { looked, settled })
  } catch (error) {
    logger.error("Unchecked photo sweep failed", { error: String(error) })
  }
}

/** Self-scheduling, like the other sweepers: a slow pass must not overlap the next. */
export function startPhotoModerationSweeper(): void {
  if (timer) return
  stopped = false
  const schedule = () => {
    if (stopped) return
    timer = setTimeout(() => {
      void runSweep().finally(schedule)
    }, SWEEP_INTERVAL_MS)
    timer.unref?.()
  }
  // Boot is when a deploy's backlog gets cleared.
  void runSweep().finally(schedule)
}

export function stopPhotoModerationSweeper(): void {
  stopped = true
  if (timer) clearTimeout(timer)
  timer = null
}
