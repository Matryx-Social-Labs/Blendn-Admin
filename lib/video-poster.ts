/**
 * A poster taken from a video's own opening frame, in the browser.
 *
 * ## The problem this solves is a visible one
 *
 * Every card and hero paints a poster and mounts the player over it. That is
 * the right structure — it means a buffering clip shows a photograph rather
 * than a black rectangle. But when the poster is a *different picture* from the
 * clip's first frame, the moment the player produces that frame the image
 * changes, and it reads as a jump: the screen settles, then visibly re-settles.
 * Preloading hides the *delay* and does nothing about the *jump*.
 *
 * If the poster is the first frame, the handoff is invisible, because nothing
 * about the picture changes — only which layer is drawing it.
 *
 * ## Why the browser and not the server
 *
 * The organiser has just chosen the file, so it is already on their machine.
 * Decoding one frame from a local file costs no network at all, where doing it
 * server-side means uploading the video, downloading it into a worker, running
 * ffmpeg and storing a second object — a queue, a failure mode and a delay
 * before the poster exists, in exchange for a frame the browser could have
 * produced instantly.
 *
 * The tradeoff is that this only works for a **file the user picked**. A pasted
 * URL is cross-origin, and drawing it to a canvas taints the canvas so
 * `toBlob` throws — which is why the manual poster field stays.
 *
 * ## Why 0.1s rather than 0
 *
 * Seeking to exactly 0 returns a frame before the first keyframe has decoded on
 * some encoders, which is either black or a smear of macroblocks — a poster
 * that looks like a fault. A tenth of a second in is past that and is still,
 * for any real clip, the same shot.
 */

/** Where in the clip to sample. See the note above. */
const POSTER_TIME_SECONDS = 0.1

/** Long enough for a large local file, short enough not to hang the form. */
const TIMEOUT_MS = 15_000

export class PosterCaptureError extends Error {}

/**
 * Grab the opening frame of `file` as a JPEG blob.
 *
 * Rejects rather than returning null, so a caller has to decide what to do —
 * and the right decision is usually to carry on without a poster and let the
 * organiser paste one, not to fail their upload.
 */
export async function captureVideoPoster(file: File): Promise<Blob> {
  if (typeof document === "undefined") {
    throw new PosterCaptureError("captureVideoPoster requires a browser")
  }

  const url = URL.createObjectURL(file)
  const video = document.createElement("video")
  video.preload = "metadata"
  video.muted = true
  // iOS Safari refuses to decode without this and gives no error, just a video
  // that never reaches `loadeddata`.
  video.playsInline = true
  video.src = url

  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        video.onerror = () => reject(new PosterCaptureError("the video could not be decoded"))
        video.onloadeddata = () => resolve()
        /*
         * Seek first, then wait for data at the new position. Listening for
         * `loadeddata` alone can resolve on the frame at 0, which is the one
         * being avoided.
         */
        video.onloadedmetadata = () => {
          video.currentTime = Math.min(POSTER_TIME_SECONDS, (video.duration || 1) / 2)
        }
      }),
    )

    const width = video.videoWidth
    const height = video.videoHeight
    if (!width || !height) {
      throw new PosterCaptureError("the video reported no dimensions")
    }

    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new PosterCaptureError("no 2d canvas context")
    ctx.drawImage(video, 0, 0, width, height)

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) =>
          blob
            ? resolve(blob)
            : reject(new PosterCaptureError("the frame could not be encoded")),
        "image/jpeg",
        // 0.82 — a poster is shown for a fraction of a second before the clip
        // covers it, so spending a larger file on it buys nothing.
        0.82,
      )
    })
  } finally {
    // Always, including on the throwing paths: an object URL that is never
    // revoked holds the whole video in memory for the life of the tab.
    URL.revokeObjectURL(url)
    video.src = ""
  }
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new PosterCaptureError("timed out reading the video")), TIMEOUT_MS),
    ),
  ])
}
