import { checkImageContent } from "./moderation/openai-moderation"
import { getMaxFileSize, getObjectSize, ownedPhotoKey } from "./tigris"
import { db } from "./db"
import { logger } from "./logger"
import { recordPhotoCheck } from "./photo-checks"

/**
 * Whether a photo may go on a profile.
 *
 * Until now, **nothing checked profile photos at all.** `checkImageContent` has
 * existed and been wired to chat media since the moderation pipeline shipped;
 * no profile photo had ever been through it. Photos are about to be the price
 * of being visible in a room, so "unchecked" stops being acceptable.
 *
 * Three gates, in a deliberate order — cheapest and most certain first:
 *
 *   1. **Ours, and theirs.** `ownedPhotoKey` proves the URL points at an object
 *      in our bucket under `profile/<userId>/`. Nothing below runs otherwise,
 *      because everything below either fetches the URL or hands it to a vendor
 *      that will. This is the SSRF gate, and it is first for that reason.
 *   2. **Not blank.** One `HeadObject`; no download, no decode. A solid colour,
 *      a lens cap or a wall compresses to a few KB where a photograph is
 *      hundreds.
 *   3. **Not harmful.** OpenAI's omni-moderation endpoint, which is free for
 *      both text and images.
 *
 * ## What this does not do
 *
 * It does not check that the image is a *person*. Omni-moderation scores harm,
 * not subject matter, so a golden retriever passes cleanly. Closing that needs
 * face detection, which means Cairo as a native dependency in the Railway image
 * plus several MB of model weights. Worth doing when photos carry more weight;
 * recorded here so nobody reads "checked" as "verified to be you".
 */

export type PhotoRejection =
  | { ok: false; code: "not_ours"; message: string }
  | { ok: false; code: "too_small"; message: string }
  | { ok: false; code: "unsafe"; message: string }
  | { ok: false; code: "too_large"; message: string }

export type PhotoVerdict = { ok: true; checked: boolean } | PhotoRejection

/**
 * 8 KB.
 *
 * A 1000×1000 solid-colour JPEG lands around 5–15 KB; a real photograph off any
 * phone camera is hundreds of KB even after the client's compression pass. The
 * floor sits below anything real and above anything empty, and it is a floor
 * rather than a range because "suspiciously large" is not a thing we care about
 * — the presigned upload already caps size.
 */
export const MIN_PHOTO_BYTES = 8_000

/**
 * The cheap gates, on the request path: ours, uploaded, not blank, not huge.
 *
 * The vendor check used to run here too, and the profile PUT — the write the
 * person is watching a spinner for — waited on OpenAI fetching and scoring
 * the image, unbounded. It now runs in `moderateProfilePhoto` after the
 * response. The read side already tolerated an unchecked photo (every
 * failure of the vendor call degraded to `checked: false` and nothing on a
 * read path consults it), so this makes the accidental path the deliberate
 * one, and the moderation screen's unchecked count is where it shows.
 */
export async function checkProfilePhoto(url: string, userId: string): Promise<PhotoVerdict> {
  const key = ownedPhotoKey(url, userId)
  if (!key) {
    return {
      ok: false,
      code: "not_ours",
      message: "Upload photos through the app rather than linking to them",
    }
  }
  const size = await getObjectSize(key)
  if (size === null) {
    // The object is not there. Almost always a client posting the URL before
    // the upload finished, which is worth saying plainly rather than calling
    // it a rejection.
    return {
      ok: false,
      code: "too_small",
      message: "That photo did not finish uploading. Try again.",
    }
  }
  if (size < MIN_PHOTO_BYTES) {
    return {
      ok: false,
      code: "too_small",
      message: "That looks like a blank image. Pick a photo of yourself.",
    }
  }
  if (size > getMaxFileSize("profile")) {
    // The presigned PUT cannot bound size; this is the first place the
    // server sees the object, so it is where the ceiling is enforced.
    return { ok: false, code: "too_large", message: "That photo is too large. Pick one under 10 MB." }
  }
  return { ok: true, checked: false }
}

/**
 * The vendor check, after the response. Pulls the photo if it fails.
 *
 * Runs inside `after()` from the profile PUT, so nobody is waiting on it.
 * A `hide` verdict removes the URL from the profile and, if it was the
 * primary, from `User.image` too — the same two writes the PUT made, undone.
 */
export async function moderateProfilePhoto(url: string, userId: string): Promise<void> {
  try {
    const check = await checkImageContent(url)
    if (check.checked && check.result?.action === "hide") {
      const profile = await db.profiles.findUnique({ where: { id: userId }, select: { photos: true } })
      const remaining = (profile?.photos ?? []).filter((u) => u !== url)
      await db.$transaction([
        db.profiles.update({ where: { id: userId }, data: { photos: remaining } }),
        db.user.update({ where: { id: userId }, data: { image: remaining[0] ?? null } }),
      ])
      await recordPhotoCheck(url, userId, true)
      logger.warn("Profile photo removed after moderation", { userId })
      return
    }
    await recordPhotoCheck(url, userId, check.checked)
  } catch (error) {
    // Nothing above us: `after()` reports a rejection with a bare
    // console.error, which is not where this app's errors go. A photo that
    // should have come down and did not is worth a real log line.
    logger.error("Profile photo moderation failed; photo left in place", {
      userId,
      url,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
