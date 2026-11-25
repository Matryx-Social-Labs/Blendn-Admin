import type { EventFormValues } from "@/components/event-form/schema"
import type { CheckedClip } from "@/lib/media-clip"
import { refusalText } from "@/lib/refusal"

type MediaItem = NonNullable<EventFormValues["media_items"]>[number]
export type ClipPatch = Partial<
  Pick<MediaItem, "width" | "height" | "duration_ms" | "thumbnail_url" | "renditions" | "clip_refusal">
>

/** What the item's line says: in this form session only; a saved clip's line comes from its row. */
export type ClipCheckState =
  | { kind: "checking" }
  | { kind: "done"; stills: CheckedClip["stills"] }
  /** `newClip` goes to the retry: the poster still there may be the old clip's. */
  | { kind: "failed"; message: string; newClip: boolean }

export type ClipAnswer = { kind: "ok"; clip: CheckedClip } | { kind: "refused"; message: string } | { kind: "failed"; message: string }

export const UNCHECKED = "We couldn’t check this clip right now. You can save it, and check it again later."

/** `POST /api/media/clip`. A 422 is a verdict on the clip; anything else says nothing about it. */
export async function askClipCheck(url: string): Promise<ClipAnswer> {
  try {
    const response = await fetch("/api/media/clip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    })
    if (response.ok) return { kind: "ok", clip: ((await response.json()) as { data: CheckedClip }).data }
    if (response.status === 422) return { kind: "refused", message: await refusalText(response, "This clip can’t be used.") }
    return { kind: "failed", message: response.status === 429 ? await refusalText(response, UNCHECKED) : UNCHECKED }
  } catch {
    return { kind: "failed", message: UNCHECKED }
  }
}

export interface CheckClipDeps {
  /** The gallery as it is now: read again after the check, because it can be reordered, cut or retyped meanwhile. */
  items: () => ReadonlyArray<Pick<MediaItem, "id" | "type" | "url" | "thumbnail_url">>
  write: (index: number, patch: ClipPatch) => void
  ask: (url: string) => Promise<ClipAnswer>
}

/**
 * Checks one gallery clip, found by its id, and fills in what it learned
 * (SCRUM-1106). A clip retyped or removed while it was being checked gets
 * nothing: the answer is about another link (null).
 *
 * `newClip`: the link or file just changed, so the poster is the new clip's
 * opening frame. A saved clip checked again keeps the still its organizer chose.
 */
export async function checkMediaClip(itemId: string, deps: CheckClipDeps, newClip: boolean): Promise<ClipCheckState | null> {
  const url = deps.items().find((m) => m.id === itemId && m.type === "video")?.url
  if (!url) return null
  const answer = await deps.ask(url)

  const index = deps.items().findIndex((m) => m.id === itemId && m.type === "video" && m.url === url)
  if (index === -1) return null
  if (answer.kind === "failed") return { ...answer, newClip }
  if (answer.kind === "refused") {
    deps.write(index, { clip_refusal: answer.message, renditions: undefined })
    return { kind: "done", stills: [] }
  }
  const { width, height, duration_ms, stills, renditions } = answer.clip
  const keepsPoster = !newClip && Boolean(deps.items()[index].thumbnail_url)
  deps.write(index, {
    width,
    height,
    duration_ms,
    renditions,
    clip_refusal: undefined,
    ...(keepsPoster ? {} : { thumbnail_url: stills[0].url }),
  })
  return { kind: "done", stills }
}

/** The done line: "12.0 s · 1280 × 720". */
export function clipFacts(width: number, height: number, durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)} s · ${width} × ${height}`
}

/** A still's time as a clock: "0:07". */
export function stillClock(seconds: number): string {
  const whole = Math.floor(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`
}
