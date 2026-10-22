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
  // Without a key every look is "did not look": nothing to retry, and no attempt to spend.
  if (!process.env.OPENAI_API_KEY) return { looked: 0, settled: 0 }
  /*
   * The per-person cap is in the query, not applied to what a read-ahead
   * happened to return: with the cap after a LIMIT, one person with more rows
   * than the window fills it and everyone behind them is starved again.
   * Unchecked rows are the few the (checked, created_at) index finds, so the
   * window runs over a small set.
   */
  const rows = await db.$queryRaw<{ url: string; user_id: string }[]>`
    SELECT url, user_id
      FROM (
        SELECT url, user_id, last_attempted_at, created_at,
               ROW_NUMBER() OVER (
                 PARTITION BY user_id
                 ORDER BY last_attempted_at ASC NULLS FIRST, created_at ASC
               ) AS slot
          FROM photo_checks
         WHERE checked = false
           AND created_at < ${new Date(now.getTime() - SWEEP_SETTLE_MS)}
           AND (attempts < ${MAX_ATTEMPTS_PER_DAY_AFTER}
                OR last_attempted_at IS NULL
                OR last_attempted_at < ${new Date(now.getTime() - BACKOFF_MS)})
      ) ranked
     WHERE slot <= ${PER_USER_SLOTS}
     ORDER BY last_attempted_at ASC NULLS FIRST, created_at ASC
     LIMIT ${BATCH_LIMIT}
  `

  for (const { url, user_id: userId } of rows) {
    try {
      // Stamped first: a row that throws, or hangs the process, still goes to the back.
      const { count } = await db.photo_checks.updateMany({ where: { url }, data: { last_attempted_at: now } })
      if (count === 0) continue // the person's account went between the read and now
      const asked = await recheck(url, userId)
      // Only a real ask counts toward the back-off: storage or the vendor being down is not the photo's doing.
      if (!asked) continue
      const row = await db.photo_checks.update({ where: { url }, data: { attempts: { increment: 1 } }, select: { attempts: true } }).catch(() => null)
      if (row?.attempts === MAX_ATTEMPTS_PER_DAY_AFTER) {
        logger.error("Photo still unjudged after many attempts; retried daily from here", { userId, attempts: row.attempts })
      }
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

/** Whether the photo was really put to the vendor (and so counts as an attempt). */
async function recheck(url: string, userId: string): Promise<boolean> {
  // The SSRF gate, again: this URL goes to a vendor that fetches it.
  const key = ownedPhotoKey(url, userId)
  if (!key) {
    /*
     * Fail closed -- but only for a URL that is plainly not the person's. One in
     * our storage family under their own path that merely fails the check is a
     * bucket name this deployment is not configured for: configuration, not a
     * verdict, and pulling on it would be bulk and irreversible.
     */
    if (looksOurs(url, userId)) {
      logger.error("Unchecked photo looks like the person's own but fails the ownership check (bucket configuration?); left alone", { userId })
      return false
    }
    logger.warn("Unchecked photo is not the person's own object; pulled", { userId })
    await pullPhoto(url, userId)
    return false
  }
  const profile = await db.profiles.findUnique({ where: { id: userId }, select: { blur_photo: true } })

  const presence = await objectPresence(key)
  // Anything but a confirmed 404 -- the network, a 5xx, a permissions error -- is "could not tell": next pass.
  if (presence === "unknown") return false
  if (presence === "gone") {
    /*
     * Nothing left to moderate, if nothing points at it; one the profile still
     * points at is not a judged photo, so its row stays. The profile is asked in
     * the delete itself: a save can put the URL back while the storage call runs.
     */
    await db.$executeRaw`
      DELETE FROM photo_checks
       WHERE url = ${url} AND checked = false
         AND NOT EXISTS (SELECT 1 FROM profiles WHERE id = ${userId} AND (${url} = ANY(photos) OR blur_photo = ${url}))`
    return false
  }
  if (profile?.blur_photo === url) await moderateBlurPhoto(url, userId)
  else await moderateProfilePhoto(url, userId)
  return true
}

/** In our storage family, under this person's own path. */
function looksOurs(url: string, userId: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === "https:" && u.hostname.endsWith(".tigris.dev") && u.pathname.startsWith(`/profile/${userId}/`)
  } catch {
    return false
  }
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
