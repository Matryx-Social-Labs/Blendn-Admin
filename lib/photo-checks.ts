// Relative, not "@/lib/db" — see lib/live-snapshot.ts for why. Enforced by
// __tests__/server-import-boundary.test.ts.
import { db } from "./db"
import { ownedPhotoKey } from "./tigris"

/**
 * Record that we looked at a photo, and whether we actually managed to.
 *
 * `checked: false` means moderation could not run — no API key, or the call
 * failed — and the upload was allowed through anyway. That is the deliberate
 * choice: a vendor outage must not stop somebody having a profile photo, the
 * same call `lib/email.ts` makes. But "allowed through during an outage" and
 * "checked and passed" are different facts, and only one is safe to leave
 * alone forever.
 *
 * Best-effort by design. If this write fails the photo is still saved; losing
 * an audit row is not a reason to reject somebody's profile picture.
 */
export async function recordPhotoCheck(
  url: string,
  userId: string,
  checked: boolean
): Promise<void> {
  try {
    await db.photo_checks.upsert({
      where: { url },
      // A photo removed and re-added keeps its original verdict rather than
      // being re-fetched. Upgrading unchecked -> checked is the only move.
      update: checked ? { checked: true } : {},
      create: { url, user_id: userId, checked },
    })
  } catch {
    // Swallowed on purpose. See above.
  }
}

/**
 * Record that moderation pulled a photo (SCRUM-479).
 *
 * Not best-effort, unlike the audit row above: this verdict is what stops a
 * save that re-sends the URL from putting it back, and what account deletion
 * keeps for its 180 days. The caller logs a failure.
 */
export async function recordPhotoPulled(url: string, userId: string): Promise<void> {
  await db.photo_checks.upsert({
    where: { url },
    update: { checked: true, hidden: true },
    create: { url, user_id: userId, checked: true, hidden: true },
  })
}

/**
 * Say that a pulled PROFILE photo is one its owner is to be told about, and
 * whether it was the main one. Separate from `recordPhotoPulled`, which a blurred
 * copy also calls and which must not become a tile. A failure is the caller's to log.
 */
export async function notePulledProfilePhoto(url: string, userId: string, wasMain: boolean): Promise<void> {
  await db.photo_checks.updateMany({
    where: { url, user_id: userId },
    data: { pulled_at: new Date(), pulled_was_main: wasMain },
  })
}

/** How long a pulled photo is shown to its owner as one that was removed. */
export const PULLED_NOTICE_DAYS = 7

/** One slot of the owner's photos: a photo that is up, or one moderation took down. */
export interface PhotoState {
  url: string
  pulled: boolean
  /** When it was pulled; null for a photo that is up. */
  pulled_at: string | null
  /** It was the main photo, so the next one is now. false for a photo that is up. */
  was_main: boolean
}

/**
 * The owner's photos with the verdict on each (`photo_states`): the ones that
 * are up, in order, then the ones moderation pulled in the last
 * `PULLED_NOTICE_DAYS`, newest first. A pulled photo's slot is gone from
 * `photos` (the profile PUT drops it) — this is how the app can say so.
 *
 * ponytail: a time window, not an acknowledgement; the owner cannot dismiss one
 * early. A `seen` column and a PUT would, if a week is ever too long.
 */
export async function photoStatesFor(userId: string, photos: readonly string[]): Promise<PhotoState[]> {
  const since = new Date(Date.now() - PULLED_NOTICE_DAYS * 24 * 60 * 60 * 1000)
  const rows = await db.photo_checks.findMany({
    where: { user_id: userId, hidden: true, pulled_at: { gte: since } },
    orderBy: { pulled_at: "desc" },
    select: { url: true, pulled_at: true, pulled_was_main: true },
  })
  const up = new Set(photos)
  return [
    ...photos.map((url) => ({ url, pulled: false, pulled_at: null, was_main: false })),
    ...rows
      .filter((r) => !up.has(r.url))
      .map((r) => ({
        url: r.url,
        pulled: true,
        pulled_at: r.pulled_at?.toISOString() ?? null,
        was_main: r.pulled_was_main ?? false,
      })),
  ]
}

/**
 * Which of these URLs are this person's photos that moderation pulled.
 *
 * Matched on the storage key, not the string: a query string, a fragment, an
 * encoded path or the other host name all name the same object and would pass
 * an exact comparison. Scoped to the person, so a stranger's pulled URL tells
 * the caller nothing about its verdict.
 */
export async function pulledPhotos(urls: readonly string[], userId: string): Promise<Set<string>> {
  if (urls.length === 0) return new Set()
  const rows = await db.photo_checks.findMany({ where: { user_id: userId, hidden: true }, select: { url: true } })
  const pulledKeys = new Set(rows.map((r) => ownedPhotoKey(r.url, userId)).filter((k): k is string => k !== null))
  return new Set(
    urls.filter((u) => {
      const key = ownedPhotoKey(u, userId)
      return key !== null && pulledKeys.has(key)
    })
  )
}

/** Photos that were let through without moderation, oldest first. */
export async function unmoderatedPhotos(limit = 100) {
  return db.photo_checks.findMany({
    where: { checked: false },
    orderBy: { created_at: "asc" },
    take: limit,
    select: { url: true, user_id: true, created_at: true },
  })
}
