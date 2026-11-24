/**
 * How the app fits one upload into each card, for the dashboard's per-card
 * preview and focal picker (SCRUM-1106, queue task 30, option A per advisor).
 *
 * The rules are the app's, not ours to vary: a preview that crops differently
 * from the phone is worse than none, because an organizer composes to it.
 * - Stills, fit rule B (owner 2026-11-17): cropped only within ±15% of the
 *   card's ratio, else shown whole over a blurred copy of themselves
 *   (`fitFor` in the app's `components/ds/LinkPreviewCard.tsx`).
 * - Clips fill every card (owner 2026-11-18), cropped at the focal point.
 * - The Story share card always shows the picture whole.
 * Sizes are the cards in points (pulse-media board 13). See `docs/MEDIA.md`.
 */

export interface MediaSize {
  width: number
  height: number
}

export interface FocalPoint {
  /** 0–1 of the picture from its left edge. */
  x: number
  /** 0–1 of the picture from its top edge. */
  y: number
}

export interface MediaCard extends MediaSize {
  key: "lead" | "hero" | "venue" | "thumb" | "story"
  label: string
  /** Always the whole picture, clip or still. */
  whole?: true
}

export const MEDIA_CARDS: readonly MediaCard[] = [
  { key: "lead", label: "Pulse lead", width: 345, height: 256 },
  { key: "hero", label: "Event hero", width: 345, height: 345 },
  { key: "venue", label: "Venue hero", width: 393, height: 300 },
  { key: "thumb", label: "Thumb", width: 64, height: 64 },
  { key: "story", label: "Story card", width: 1080, height: 1920, whole: true },
]

/** Rule B: a still crops only when its ratio is this close to the card's. */
export const FIT_TOLERANCE = 0.15

/** Where the app crops with no point set: faces sit high (`COVER_FOCUS` in the app). */
export const DEFAULT_FOCUS: FocalPoint = { x: 0.5, y: 0.4 }

const known = (s: MediaSize | null | undefined): s is MediaSize => !!s && s.width > 0 && s.height > 0

/** Rule B: `cover` within ±15% of the frame's ratio, else `contain`. An unknown size never crops. */
export function fitFor(media: MediaSize | null | undefined, frame: MediaSize): "cover" | "contain" {
  if (!known(media) || !known(frame)) return "contain"
  const off = media.width / media.height / (frame.width / frame.height) - 1
  // Rounded as the app rounds, so exactly 15% off is inside whatever the floating point makes of it.
  return Math.round(Math.abs(off) * 1e6) <= FIT_TOLERANCE * 1e6 ? "cover" : "contain"
}

export function cardFit(card: MediaCard, media: MediaSize | null | undefined, type: string): "cover" | "contain" {
  if (card.whole) return "contain"
  if (type === "video") return "cover"
  return fitFor(media, card)
}

/**
 * The CSS `object-position` (percent per axis) that keeps the point as near
 * the frame's centre as the picture allows, for an `object-fit: cover` crop.
 * `p%` lines up p% of the picture with p% of the frame, so the overflow on an
 * axis is shifted by p% of itself; an axis with nothing to crop is 50.
 */
export function focusPosition(media: MediaSize, frame: MediaSize, focus: FocalPoint | null): FocalPoint {
  const f = focus ?? DEFAULT_FOCUS
  const scale = Math.max(frame.width / media.width, frame.height / media.height)
  const axis = (drawn: number, room: number, at: number) => {
    const overflow = drawn - room
    if (overflow <= 0.5) return 50
    return Math.min(100, Math.max(0, ((at * drawn - room / 2) / overflow) * 100))
  }
  return {
    x: axis(media.width * scale, frame.width, f.x),
    y: axis(media.height * scale, frame.height, f.y),
  }
}

/**
 * Whether any card actually cuts something off: the picker is shown only then
 * (advisor). A square still lands nowhere near a crop, so it gets no picker.
 */
export function cropsWithSlack(media: MediaSize | null | undefined, type: string): boolean {
  if (type === "video") return true
  if (!known(media)) return false
  const ratio = media.width / media.height
  return MEDIA_CARDS.some(
    (card) => cardFit(card, media, type) === "cover" && Math.abs(ratio - card.width / card.height) > 0.005
  )
}

/** What a click stores: inside the picture, two decimal places. */
export function focalPoint(v: number): number {
  return Math.round(Math.min(1, Math.max(0, v)) * 100) / 100
}
