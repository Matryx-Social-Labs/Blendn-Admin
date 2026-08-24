import { CHAT_WINDOW_HOURS } from "./chat-window"

/**
 * Whether an event is the platform's or an organiser's, and whether anyone may
 * claim it.
 *
 * ## Why this is a column and not an absence
 *
 * The obvious representation for "unclaimed" is `organizer_org_id IS NULL`, and
 * it is wrong. That column is null for three unrelated reasons: a legacy row, an
 * event created before anything wrote it, and a curated event awaiting a claim.
 * Measured against production on 2026-08-24, **18 of 28 events had a null
 * `organizer_org_id`** and not one of them was curated.
 *
 * Offering those for claiming would let a stranger claim a real organiser's
 * event. `curated_at` is the only clause that separates them, which is why it
 * exists.
 *
 * ## Four states, and the two that matter
 *
 * | `curated_at` | `claimed_at` | state |
 * |---|---|---|
 * | null | null | `organiser` — or `legacy`, if nothing owns it |
 * | null | set | impossible; asserted against |
 * | set | null | **`curated_open`** — the platform runs it, anyone may claim |
 * | set | set | **`curated_claimed`** — an organiser proved it and took over |
 *
 * `claimed_at` rather than "does it have an org now": ownership answers *who*,
 * and this answers *what happened*. Keeping them apart means a later transfer
 * between organisations does not make an event look uncurated.
 */

/** The columns every function here needs. Spread it; do not hand-pick. */
export const curationSelect = {
  curated_at: true,
  claimed_at: true,
  organizer_org_id: true,
  start_time: true,
  end_time: true,
} as const

export interface CuratedEvent {
  curated_at: Date | null
  claimed_at: Date | null
  organizer_org_id: string | null
  start_time: Date
  end_time: Date
}

export type CurationState =
  /** An organiser created it and their organisation owns it. */
  | "organiser"
  /** Created before organisations existed, or before anything wrote the column. */
  | "legacy"
  /** The platform added it from a public listing. Nobody has claimed it. */
  | "curated_open"
  /** Curated, then claimed and approved. */
  | "curated_claimed"

export function curationState(event: {
  curated_at: Date | null
  claimed_at: Date | null
  organizer_org_id: string | null
}): CurationState {
  if (event.curated_at) return event.claimed_at ? "curated_claimed" : "curated_open"
  return event.organizer_org_id ? "organiser" : "legacy"
}

/**
 * Why a claim cannot be filed right now. `null` means it can.
 *
 * Reasons rather than a boolean, because they have different remedies and one
 * of them is temporary — "come back after the event" is a very different answer
 * from "this is not ours to give".
 */
export type ClaimRefusal =
  /** Not curated. An organiser's own event is not on offer. */
  | "not_curated"
  /** Somebody already claimed it and was approved. */
  | "already_claimed"
  /** The room is live or still open. See below. */
  | "room_open"

/**
 * ## Claims are refused while the room is open
 *
 * From doors until the chat window closes. Delay costs a real organiser a few
 * hours; approving hands a stranger the attendee list for people who are
 * physically in a building right now, and there is no undo — `unclaimEvent` can
 * return the column, and it cannot un-see a roster.
 *
 * The venue queue's argument that its bar "does not have to be bulletproof,
 * because auto-link is reversible" is exactly what does not transfer here.
 *
 * Bounded by the chat window rather than by `end_time`, because that is when
 * the room stops being readable — an approval an hour after the last song still
 * hands over a live conversation.
 */
export function claimRefusal(
  event: CuratedEvent,
  now: Date = new Date()
): ClaimRefusal | null {
  if (!event.curated_at) return "not_curated"
  if (event.claimed_at) return "already_claimed"

  const doors = event.start_time.getTime()
  const roomCloses = event.end_time.getTime() + CHAT_WINDOW_HOURS * 60 * 60 * 1000
  if (now.getTime() >= doors && now.getTime() < roomCloses) return "room_open"

  return null
}

/** Convenience for the read paths that only need a yes or no. */
export function isClaimable(event: CuratedEvent, now: Date = new Date()): boolean {
  return claimRefusal(event, now) === null
}

/**
 * The description a curated event is published with.
 *
 * Facts only, generated here rather than copied. Decision 2 forbids reproducing
 * a listing's prose or images, and the reason is not only legal: a description
 * lifted from somewhere else reads as somebody else's, and the honest line —
 * *we found this, go and check the source* — is the one that keeps the platform
 * trustworthy when a detail turns out to be wrong.
 *
 * `full_description` and `cover_image_url` stay empty for the same reason, and
 * that is enforced by the curation write path rather than by remembering.
 */
export function curatedDescription(input: {
  title: string
  venueName: string | null
  city: string | null
}): string {
  const where = [input.venueName, input.city].filter(Boolean).join(", ")
  const at = where ? ` at ${where}` : ""
  return (
    `${input.title}${at}. Listed by Blendn from a public listing — ` +
    `see the source for details and tickets.`
  )
}
