// Relative imports: reachable from `server.ts` (via `background.ts`), which
// `build:server` compiles with plain tsc -- the `@/` alias would be emitted verbatim.
import { db } from "./db"
import { logger } from "./logger"
import { moderateBlurPhoto, moderateProfilePhoto } from "./photos"
import { headObject, ownedPhotoKey } from "./tigris"

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
 * pulled exactly as the first look would have pulled it.
 *
 * The verdict goes through the two functions the profile write already uses
 * (`moderateProfilePhoto`, `moderateBlurPhoto`), so a pass, a pull and the
 * 180-day hold mean one thing wherever the verdict comes from.
 */
export const SWEEP_INTERVAL_MS = 10 * 60 * 1000
/** The write that made the row runs its own check after the response; give it time to finish first. */
export const SWEEP_SETTLE_MS = 2 * 60 * 1000
const BATCH_LIMIT = 25

export interface PhotoSweepResult {
  /** Rows looked at this pass. */
  looked: number
  /** Rows no longer on the unchecked list: checked, or dropped because the object is gone. */
  settled: number
}

export async function sweepUnmoderatedPhotos(now: Date = new Date()): Promise<PhotoSweepResult> {
  // Newest first: a photo that keeps failing must not hold the front of the queue against the ones behind it.
  const rows = await db.photo_checks.findMany({
    where: { checked: false, created_at: { lt: new Date(now.getTime() - SWEEP_SETTLE_MS) } },
    orderBy: { created_at: "desc" },
    take: BATCH_LIMIT,
    select: { url: true, user_id: true },
  })

  for (const { url, user_id: userId } of rows) {
    try {
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
  // The SSRF gate, again: this URL goes to a vendor that fetches it.
  const key = ownedPhotoKey(url, userId)
  if (!key) {
    logger.warn("Unchecked photo is not the person's own object; left alone", { userId })
    return
  }
  // An object that is gone has nothing left to moderate; the row would be retried for ever.
  if ((await headObject(key)) === null) {
    await db.photo_checks.deleteMany({ where: { url, checked: false } })
    return
  }
  const profile = await db.profiles.findUnique({ where: { id: userId }, select: { blur_photo: true } })
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
