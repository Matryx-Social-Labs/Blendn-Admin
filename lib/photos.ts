import { checkImageContent } from "./moderation/openai-moderation"
import { getObjectSize, ownedPhotoKey } from "./tigris"

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

export async function checkProfilePhoto(url: string, userId: string): Promise<PhotoVerdict> {
  const key = ownedPhotoKey(url, userId)
  if (!key) {
    /*
     * Deliberately not specific.
     *
     * "Wrong host", "wrong owner" and "malformed" are one message, because the
     * useful version of this error tells an attacker which part of their probe
     * was closer. A real client cannot hit this at all: it uploads through
     * `POST /uploads/presigned-url` and posts back the `publicUrl` it was
     * handed.
     */
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

  const check = await checkImageContent(url)
  if (check.checked && check.result?.action === "hide") {
    return {
      ok: false,
      code: "unsafe",
      message: "That photo cannot be used here.",
    }
  }

  /*
   * `checked: false` when moderation could not run.
   *
   * Degrading **open** is the deliberate choice: a moderation outage must not
   * stop people having a profile photo, which is the same call `lib/email.ts`
   * makes. The row records `unchecked` so it can be swept later rather than
   * being silently assumed fine.
   *
   * This used to be `verdict !== null || hasModerationKey()`, an approximation
   * of a question the API could not answer: `checkImageContent` returned null
   * for clean, for a missing key and for a failed call alike. So a configured
   * key plus an API error read as **checked** -- the one combination where the
   * guess is wrong, and the one that happens during an outage. It now asks
   * directly, and `hasModerationKey` is gone with it.
   */
  return { ok: true, checked: check.checked }
}
