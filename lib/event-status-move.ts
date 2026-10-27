import type { rsvp_status } from "@prisma/client"

import { db } from "./db"
import { UNCANCEL_REFUSAL } from "./event-cancellation"

/**
 * Which status moves a client may make on an event, for every door that takes
 * a status from a request: the dashboard `POST /api/events` and
 * `PATCH /api/events/:id`, and the mobile `PATCH /events/:eventId`.
 *
 * The publish checks (a pin or a fence, and for Razorpay's review
 * organisation, never) live on the way into `published`. Anything else that
 * is not a draft is public too: the app opens a cancelled or completed event
 * (`attendeeEventAccess` refuses only drafts), and the share page serves both.
 * So `cancelled` or `completed` straight from a draft, or on create, was a way
 * past every publish check. Now:
 *
 * - a new event is a draft, or published (through the publish checks);
 * - `published` only from a draft; back to `draft` only from published
 *   (unpublishing hides it);
 * - `cancelled` from published, or from a draft people have RSVP'd to (an
 *   event an admin unpublished: cancelling is how they are told); a draft
 *   with no RSVPs is deleted instead;
 * - out of `cancelled`, never (`UNCANCEL_REFUSAL`);
 * - `completed` is never a client's to write, and a completed event stays so.
 *
 * Saving with the status it already has is no move. The admin status control
 * (`lib/admin-role-actions.ts`) and curation are not clients and keep their
 * own rules.
 */
export const CREATE_STATUS_REFUSAL = "A new event is saved as a draft, or published."
export const CANCEL_DRAFT_REFUSAL =
  "Nobody has RSVP’d to this draft, so there is nobody to tell it is cancelled. Delete it instead."
export const COMPLETED_REFUSAL = "An event is marked completed by Blend’n, not by a save."
export const FROM_COMPLETED_REFUSAL = "This event has ended and can’t be reopened."

/** Why this move is refused, or null. `current` null is a create. `draftHasRsvps`: see `cancelMayLeaveDraft`. */
export function statusMoveRefusal(
  next: string | null | undefined,
  current: string | null,
  opts: { draftHasRsvps?: boolean } = {}
): string | null {
  if (current === null) return next == null || next === "draft" || next === "published" ? null : CREATE_STATUS_REFUSAL
  if (next == null || next === current) return null
  if (current === "cancelled") return UNCANCEL_REFUSAL
  if (current === "completed") return FROM_COMPLETED_REFUSAL
  if (next === "published") return null // from a draft
  if (next === "draft") return null // from published: unpublishing
  if (next === "cancelled") return current === "published" || opts.draftHasRsvps ? null : CANCEL_DRAFT_REFUSAL
  return COMPLETED_REFUSAL
}

/** A move out of draft: what Razorpay's review organisation may never make (`lib/review-demo-org.ts`). */
export function leavesDraft(next: string | null | undefined, current: string | null): boolean {
  if (current === null) return (next ?? "draft") !== "draft"
  return next != null && next !== "draft" && next !== current
}

/** RSVPs that would be told of a cancel: the people `notifyEventCancelled` writes to. */
const TOLD: rsvp_status[] = ["going", "maybe", "waitlisted"]

/**
 * `statusMoveRefusal` with the one fact it needs from the database: whether a
 * draft about to be cancelled has anybody to tell. Asked only for that move,
 * so every other save costs no query.
 */
export async function statusMoveRefusalFor(
  eventId: string,
  next: string | null | undefined,
  current: string | null,
  client: Pick<typeof db, "event_rsvps"> = db
): Promise<string | null> {
  const asks = next === "cancelled" && current === "draft"
  const draftHasRsvps = asks && (await client.event_rsvps.count({ where: { event_id: eventId, status: { in: TOLD } } })) > 0
  return statusMoveRefusal(next, current, { draftHasRsvps })
}
