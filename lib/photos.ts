import { checkImageContent } from "./moderation/openai-moderation"
import { ownedPhotoKey, sealUpload, type SealRefusal } from "./tigris"
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
  | { ok: false; code: "wrong_type"; message: string }

/** `url` is the sealed copy: the one the profile stores (SCRUM-425). */
export type PhotoVerdict = { ok: true; checked: boolean; url: string } | PhotoRejection

/**
 * 8 KB.
 *
 * A 1000×1000 solid-colour JPEG lands around 5–15 KB; a real photograph off any
 * phone camera is hundreds of KB even after the client's compression pass. The
 * floor sits below anything real and above anything empty, and it is a floor
 * rather than a range because "suspiciously large" is not a thing we care about
 * — the folder's ceiling is applied to the sealed copy.
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
  return sealOwn(url, userId, MIN_PHOTO_BYTES, undefined, PHOTO_REFUSAL)
}

/**
 * The largest file that is still a blur (SCRUM-476).
 *
 * The app's derivative is 40 pixels wide and a few KB. Anything big enough to
 * pass a photo's floor is sharp enough to be the photo, and the blurred copy
 * is exactly what a viewer who has not identified someone is allowed to see.
 */
export const MAX_BLUR_BYTES = MIN_PHOTO_BYTES

/** The blurred copy of the primary photo: the caller's own upload, sealed, and small. */
export async function checkBlurPhoto(url: string, userId: string): Promise<PhotoVerdict> {
  return sealOwn(url, userId, 1, MAX_BLUR_BYTES, BLUR_REFUSAL)
}

async function sealOwn(
  url: string,
  userId: string,
  minBytes: number,
  maxBytes: number | undefined,
  refusals: Record<SealRefusal, PhotoRejection>
): Promise<PhotoVerdict> {
  const key = ownedPhotoKey(url, userId)
  if (!key) {
    return {
      ok: false,
      code: "not_ours",
      message: "Upload photos through the app rather than linking to them",
    }
  }
  /*
   * The copy is what is measured and stored (SCRUM-425). The URL the client
   * uploaded to can write for 15 minutes, which is how a photo was swapped
   * for another after it was attached and moderated; nobody holds one for the
   * copy.
   */
  const sealed = await sealUpload(key, "profile", userId, minBytes, maxBytes)
  if ("refused" in sealed) return refusals[sealed.refused]
  return { ok: true, checked: false, url: sealed.url }
}

const PHOTO_REFUSAL: Record<SealRefusal, PhotoRejection> = {
  // Almost always a client posting the URL before the upload finished, which
  // is worth saying plainly rather than calling it a rejection.
  missing: { ok: false, code: "too_small", message: "That photo did not finish uploading. Try again." },
  too_small: { ok: false, code: "too_small", message: "That looks like a blank image. Pick a photo of yourself." },
  too_large: { ok: false, code: "too_large", message: "That photo is too large. Pick one under 10 MB." },
  wrong_type: { ok: false, code: "wrong_type", message: "That file isn't a photo. Pick a JPEG, PNG or WebP." },
}

const BLUR_REFUSAL: Record<SealRefusal, PhotoRejection> = {
  ...PHOTO_REFUSAL,
  too_large: { ok: false, code: "too_large", message: "The blurred copy of your photo is too sharp to send. Update the app and try again." },
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
      const photos = profile?.photos ?? []
      const remaining = photos.filter((u) => u !== url)
      // The blur is of the primary (SCRUM-476): a pulled primary takes its blur with it.
      const blur = photos[0] === url ? { blur_photo: null } : {}
      await db.$transaction([
        db.profiles.update({ where: { id: userId }, data: { photos: remaining, ...blur } }),
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

/**
 * The vendor check for a blurred photo, after the response (SCRUM-476).
 *
 * Only clears the column if it still holds this URL: a newer blur saved in the
 * meantime is not this verdict's to remove.
 */
export async function moderateBlurPhoto(url: string, userId: string): Promise<void> {
  try {
    const check = await checkImageContent(url)
    if (check.checked && check.result?.action === "hide") {
      await db.profiles.updateMany({ where: { id: userId, blur_photo: url }, data: { blur_photo: null } })
      logger.warn("Blurred profile photo removed after moderation", { userId })
    }
  } catch (error) {
    logger.error("Blurred photo moderation failed; left in place", {
      userId,
      url,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
