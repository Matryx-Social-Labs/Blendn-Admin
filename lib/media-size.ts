/**
 * The size of a picked media file, read in the browser before it uploads
 * (SCRUM-1066). Sent with the media item so the app can choose a card's fit
 * before the bytes land, and so a clip over the length limit is refused before
 * twelve megabytes go up for nothing.
 *
 * Both readers report the size as displayed: `createImageBitmap` applies EXIF
 * orientation, and `videoWidth`/`videoHeight` apply a clip's rotation. Never
 * fatal: a file the browser cannot decode uploads without a size, as a pasted
 * URL does.
 */

import { MEDIA } from "@/lib/constants"

export interface MediaSize {
  width: number
  height: number
  duration_ms?: number
}

/** Long enough for a large local file, short enough not to hang the form. */
const TIMEOUT_MS = 15_000

/** The shape sent, from what the browser reported. */
export function mediaSize(width: number, height: number, durationSeconds?: number): MediaSize | null {
  if (!(width > 0 && height > 0)) return null
  // Past what the save accepts: go without a size, as a pasted URL does.
  if (Math.max(width, height) > MEDIA.MAX_SIDE_PX) return null
  const size: MediaSize = { width: Math.round(width), height: Math.round(height) }
  return durationSeconds !== undefined && Number.isFinite(durationSeconds) && durationSeconds > 0
    ? { ...size, duration_ms: Math.round(durationSeconds * 1000) }
    : size
}

/** Whether a clip is refused: past the limit by more than an export's padding. The write schema's rule, before the upload. */
export function clipTooLong(durationMs: number): boolean {
  return durationMs > MEDIA.MAX_CLIP_MS + MEDIA.CLIP_TOLERANCE_MS
}

export async function readMediaSize(file: File, type: "image" | "video"): Promise<MediaSize | null> {
  try {
    return type === "image" ? await readImageSize(file) : await readVideoSize(file)
  } catch {
    return null
  }
}

async function readImageSize(file: File): Promise<MediaSize | null> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" })
  try {
    return mediaSize(bitmap.width, bitmap.height)
  } finally {
    bitmap.close()
  }
}

async function readVideoSize(file: File): Promise<MediaSize | null> {
  const url = URL.createObjectURL(file)
  const video = document.createElement("video")
  video.preload = "metadata"
  video.muted = true
  video.playsInline = true
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await new Promise<MediaSize | null>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("timed out reading the clip")), TIMEOUT_MS)
      video.onerror = () => reject(new Error("the clip could not be decoded"))
      video.onloadedmetadata = () => resolve(mediaSize(video.videoWidth, video.videoHeight, video.duration))
      video.src = url
    })
  } finally {
    clearTimeout(timer)
    video.removeAttribute("src")
    URL.revokeObjectURL(url)
  }
}
