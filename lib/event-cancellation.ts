import { db } from "@/lib/db"

/**
 * Cancelling an event cancels the check-ins standing inside it.
 *
 * ```
 *   events.status -> cancelled
 *          │
 *          └─> event_check_ins  pending    ─┐
 *                               checked_in ─┴─> cancelled
 * ```
 *
 * Without this, a cancelled event keeps every `pending` and `checked_in` row
 * live: the room still shows attendees inside, and they keep counting toward
 * occupancy and toward attendance. That was Fix #35, applied to the dashboard
 * route.
 *
 * It lives here rather than inline because the mobile route cancels events too
 * and did not cascade, so the exact state Fix #35 was written to prevent was
 * reachable through the other door. Two routes, one rule, one implementation.
 *
 * Idempotent: the `status` filter means a second call over an already-cancelled
 * event updates nothing.
 */
export async function cancelEventCheckIns(eventId: string): Promise<number> {
  const { count } = await db.event_check_ins.updateMany({
    where: {
      event_id: eventId,
      status: { in: ["pending", "checked_in"] },
    },
    data: { status: "cancelled", updated_at: new Date() },
  })
  return count
}

/**
 * Whether this write is the transition INTO cancelled.
 *
 * The cascade must not re-run on every subsequent save of an already-cancelled
 * event, and must not run when `status` is absent from a partial update.
 */
export function isCancellingEvent(
  nextStatus: string | undefined,
  currentStatus: string
): boolean {
  return nextStatus === "cancelled" && currentStatus !== "cancelled"
}

/**
 * Whether this write would take an event back OUT of cancelled.
 *
 * Cancelling is terminal: the check-ins were closed, the room archived, and
 * everyone going was told "This event has been cancelled" -- the confirm the
 * organiser accepted says "This cannot be undone". Driven 2026-09-13: the
 * editor's "Save as draft" then flipped the row to `draft`, from where
 * Publish reopens it, and nobody who was told it was off is told it is on.
 * Both PATCH routes refuse the transition; a cancelled event is re-run by
 * creating a new one (or cloning it).
 */
export function isUncancellingEvent(
  nextStatus: string | null | undefined,
  currentStatus: string
): boolean {
  return currentStatus === "cancelled" && nextStatus != null && nextStatus !== "cancelled"
}

export const UNCANCEL_REFUSAL =
  "This event was cancelled and everyone going was told. Create a new event instead."
