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
 * - `cancelled` only from published — a draft nobody saw is deleted instead;
 * - out of `cancelled`, never (`UNCANCEL_REFUSAL`);
 * - `completed` is never a client's to write, and a completed event stays so.
 *
 * Saving with the status it already has is no move. The admin status control
 * (`lib/admin-role-actions.ts`) and curation are not clients and keep their
 * own rules.
 */
export const CREATE_STATUS_REFUSAL = "A new event is saved as a draft, or published."
export const CANCEL_DRAFT_REFUSAL = "Only a published event can be cancelled. A draft nobody has seen can be deleted instead."
export const COMPLETED_REFUSAL = "An event is marked completed by Blend’n, not by a save."
export const FROM_COMPLETED_REFUSAL = "This event has ended and can’t be reopened."

/** Why this move is refused, or null. `current` null is a create. */
export function statusMoveRefusal(next: string | null | undefined, current: string | null): string | null {
  if (current === null) return next == null || next === "draft" || next === "published" ? null : CREATE_STATUS_REFUSAL
  if (next == null || next === current) return null
  if (current === "cancelled") return UNCANCEL_REFUSAL
  if (current === "completed") return FROM_COMPLETED_REFUSAL
  if (next === "published") return null // from a draft
  if (next === "draft") return null // from published: unpublishing
  if (next === "cancelled") return current === "published" ? null : CANCEL_DRAFT_REFUSAL
  return COMPLETED_REFUSAL
}

/** A move out of draft: what Razorpay's review organisation may never make (`lib/review-demo-org.ts`). */
export function leavesDraft(next: string | null | undefined, current: string | null): boolean {
  if (current === null) return (next ?? "draft") !== "draft"
  return next != null && next !== "draft" && next !== current
}
