import type { Prisma } from "@prisma/client"

/** One media item as `eventWriteSchema` hands it over. */
export interface EventMediaInput {
  type: "image" | "video" | "document"
  url: string
  thumbnail_url?: string | null
  title?: string | null
  description?: string | null
  order?: number | null
  width?: number | null
  height?: number | null
  duration_ms?: number | null
}

/**
 * The `event_media` rows for an event's media list: the create and the edit
 * route write the same rows.
 *
 * Empty strings and nulls leave the column out rather than writing "" or
 * `undefined` (`strictUndefinedChecks`). A length goes only on a clip: the
 * database refuses one anywhere else (`event_media_duration_on_video`), and
 * the editor can keep a stale one after the type is switched.
 */
export function eventMediaRows(
  items: readonly EventMediaInput[]
): Prisma.event_mediaCreateWithoutEventInput[] {
  return items.map((item, index) => ({
    type: item.type,
    url: item.url,
    ...(item.thumbnail_url && { thumbnail_url: item.thumbnail_url }),
    ...(item.title && { title: item.title }),
    ...(item.description && { description: item.description }),
    ...(item.width != null && item.height != null && { width: item.width, height: item.height }),
    ...(item.type === "video" && item.duration_ms != null && { duration_ms: item.duration_ms }),
    order: item.order ?? index,
  }))
}
