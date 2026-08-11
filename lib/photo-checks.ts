// Relative, not "@/lib/db" — see lib/live-snapshot.ts for why. Enforced by
// __tests__/server-import-boundary.test.ts.
import { db } from "./db"

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

/** Photos that were let through without moderation, oldest first. */
export async function unmoderatedPhotos(limit = 100) {
  return db.photo_checks.findMany({
    where: { checked: false },
    orderBy: { created_at: "asc" },
    take: limit,
    select: { url: true, user_id: true, created_at: true },
  })
}
