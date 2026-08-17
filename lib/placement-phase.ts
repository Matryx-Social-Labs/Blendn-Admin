import type { placement_status } from "@prisma/client"

/**
 * What a placement is doing right now.
 *
 * Four of these are stored (`placement_status`); two are derived. That split is
 * deliberate and it is the whole reason this module exists.
 *
 *     draft      the organiser typed a brand; nothing has been agreed
 *     proposed   sent to a brand that has an account, awaiting their answer
 *     upcoming   approved, event has not started
 *     live       approved, event is running
 *     ended      approved, event is over
 *     cancelled  either party pulled out
 *
 * `live` and `ended` are NOT columns. Storing them would need a sweeper to
 * advance the row when an event starts and again when it finishes, and a
 * sweeper that is late — or wedged, or mid-deploy — makes the database disagree
 * with the clock. A placement would read `upcoming` during its own event.
 *
 * Deriving them means the answer is always exactly as correct as `now`.
 *
 * The same reasoning is already applied to events in `lib/event-phase.ts`; this
 * mirrors its shape so the two read alike.
 *
 * **Authorization does not use this.** `canBroadcast` gates on
 * `status === "approved"`, a stored value, never on a phase computed here — a
 * derived value is the wrong thing to hang a permission on, and the venue
 * learning (`venue_link_status` is always `auto_linked` at decision time) is the
 * standing example of why.
 */
export type PlacementPhase =
  | "draft"
  | "proposed"
  | "upcoming"
  | "live"
  | "ended"
  | "cancelled"

export function placementPhase(
  placement: { status: placement_status },
  event: { start_time: Date; end_time: Date },
  now = new Date()
): PlacementPhase {
  // Non-approved statuses describe the agreement, not the clock, so they pass
  // through untouched. A cancelled placement at a live event is cancelled.
  if (placement.status !== "approved") return placement.status

  if (now < event.start_time) return "upcoming"
  if (now > event.end_time) return "ended"
  return "live"
}

/**
 * Whether this placement may carry a sponsored message right now.
 *
 * Approved and not finished. Deliberately NOT "live": a campaign is armed
 * before doors so the first send can land as the room opens, and the room
 * itself opens before the event for people who said they are coming.
 *
 * The scheduler still consults `chatWindowState` per send — this answers "is
 * the commercial agreement current", not "is the room open", and both have to
 * be true.
 */
export function placementIsRunnable(
  placement: { status: placement_status },
  event: { start_time: Date; end_time: Date },
  now = new Date()
): boolean {
  const phase = placementPhase(placement, event, now)
  return phase === "upcoming" || phase === "live"
}
