import type { EventFormValues } from "@/components/event-form/schema"
import { MEDIA } from "@/lib/constants"
import type { MediaSize } from "@/lib/media-size"
import { clipTooLong } from "@/lib/media-size"

type MediaItem = NonNullable<EventFormValues["media_items"]>[number]
type MediaPatch = Pick<MediaItem, "url" | "thumbnail_url" | "width" | "height" | "duration_ms">

export interface UploadMediaDeps {
  /** The gallery as it is now: read again after the upload, because it can be reordered or cut meanwhile. */
  items: () => ReadonlyArray<Pick<MediaItem, "id" | "type">>
  write: (index: number, patch: MediaPatch) => void
  upload: (file: File, onProgress?: (percent: number) => void) => Promise<string>
  readSize: (file: File, type: "image" | "video") => Promise<MediaSize | null>
  capturePoster: (file: File) => Promise<Blob>
  onProgress: (percent: number) => void
}

export type UploadMediaResult =
  | { kind: "refused"; reason: string }
  | { kind: "removed" }
  | { kind: "done"; posterMissing: boolean }

/**
 * Uploads a picked file into one gallery item, found by its id (task 30 item 7).
 *
 * By id, not index: an upload outlives a drag, and the index it started at may
 * hold another item by the time the bytes land; one that was removed gets
 * nothing. Everything is written in one go at the end, at the item's index then.
 *
 * The poster always comes from this file. It used to be taken only when the
 * field was empty, so a second clip kept the first clip's frame and an image
 * kept the old image. A clip whose frame cannot be read gets no poster rather
 * than the old one: the cover backs it, and the caller says so.
 *
 * Measured before the upload (SCRUM-1066): the app chooses a card's fit from the
 * size before the bytes land, and a clip over the limit is refused here rather
 * than after twelve megabytes went up.
 */
export async function uploadMediaItem(file: File, itemId: string, deps: UploadMediaDeps): Promise<UploadMediaResult> {
  const type = deps.items().find((m) => m.id === itemId)?.type
  if (!type) return { kind: "removed" }

  const size = type === "image" || type === "video" ? await deps.readSize(file, type) : null
  if (type === "video" && size?.duration_ms && clipTooLong(size.duration_ms)) {
    return {
      kind: "refused",
      reason: `This clip is ${(size.duration_ms / 1000).toFixed(1)} seconds. Clips play up to ${MEDIA.MAX_CLIP_MS / 1000} seconds: trim it and upload again.`,
    }
  }

  const url = await deps.upload(file, deps.onProgress)
  const poster = type === "video" ? await posterFor(file, deps) : type === "image" ? url : undefined

  const index = deps.items().findIndex((m) => m.id === itemId)
  if (index === -1) return { kind: "removed" }
  deps.write(index, {
    url,
    width: size?.width,
    height: size?.height,
    duration_ms: size?.duration_ms,
    ...(poster === undefined ? {} : { thumbnail_url: poster ?? "" }),
  })
  return { kind: "done", posterMissing: type === "video" && poster === null }
}

/** The clip's own opening frame, uploaded; null when the browser cannot decode it. */
async function posterFor(file: File, deps: UploadMediaDeps): Promise<string | null> {
  try {
    const frame = await deps.capturePoster(file)
    return await deps.upload(
      new File([frame], `${file.name.replace(/\.[^.]+$/, "")}-poster.jpg`, { type: "image/jpeg" })
    )
  } catch {
    return null
  }
}
