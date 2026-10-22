import { db } from "@/lib/db"
import { logger } from "@/lib/logger"

/**
 * Cancelling an event cancels the check-ins standing inside it.
 *
 * ```
 *   events.status -> cancelled
 *          │
 *          ├─> event_check_ins    pending    ─┐
 *          │                      checked_in ─┴─> cancelled
 *          └─> presence_sessions  open ──────────> departed, 'ended'
 * ```
 *
 * Without this, a cancelled event keeps every `pending` and `checked_in` row
 * live: the room still shows attendees inside, and they keep counting toward
 * occupancy and toward attendance. That was Fix #35, applied to the dashboard
 * route.
 *
 * The sessions are closed here too, because nothing else will in time: every
 * checkout path acts on `checked_in` rows only, and occupancy reads "inside" as
 * an open session. Cancelling the check-ins alone left the room counting its
 * last headcount (SCRUM-490), until `closeStrandedSessions` got to it once the
 * occurrence was over, as inference. `ended` here because the room closed at a
 * known instant, by a person's decision.
 *
 * It lives here rather than inline because the mobile route cancels events too
 * and did not cascade, so the exact state Fix #35 was written to prevent was
 * reachable through the other door. Two routes, one rule, one implementation.
 *
 * Idempotent: the `status` and `departed_at` filters mean a second call over an
 * already-cancelled event updates nothing, and a departure already recorded
 * keeps its own time and source. It also finds nobody checked in, so nobody is
 * told twice.
 *
 * Returns the cancelled count and `inside`, the people who were checked in and
 * have been told (`tellInsideCancelled`), for `notifyEventCancelled` to skip.
 */
export async function cancelEventCheckIns(eventId: string): Promise<{ count: number; inside: string[] }> {
  // Read BEFORE the cascade: afterwards nothing says who was inside.
  const inside = await userIdsInside(eventId)
  const now = new Date()
  const [{ count }] = await db.$transaction([
    db.event_check_ins.updateMany({
      where: {
        event_id: eventId,
        status: { in: ["pending", "checked_in"] },
      },
      data: { status: "cancelled", updated_at: now },
    }),
    /*
     * GREATEST, not `now`: `departed_at >= arrived_at` is a CHECK, and an
     * arrival can be later than this clock (another instance's, a check-in
     * racing the cancel, a seeded world's sessions at a future start). One such
     * row would fail the whole cascade, and the event, already cancelled by
     * the caller, would never re-run it. Raw because `updateMany` cannot set a
     * column from another.
     */
    db.$executeRaw`
      UPDATE presence_sessions
         SET departed_at = GREATEST(arrived_at, ${now}), departed_source = 'ended', updated_at = ${now}
       WHERE event_id = ${eventId}::uuid AND departed_at IS NULL
    `,
  ])
  await tellInsideCancelled(eventId, inside)
  return { count, inside }
}

/** People per page when reading who is inside, and per push batch. A concert room is thousands. */
export const CANCEL_PAGE = 1000
export const CANCEL_PUSH_BATCH = 500

/** Who is checked in to the event right now, a page at a time, never one unbounded read. */
async function userIdsInside(eventId: string): Promise<string[]> {
  const ids = new Set<string>()
  let after: string | undefined
  for (;;) {
    const page = await db.event_check_ins.findMany({
      where: { event_id: eventId, status: "checked_in" },
      select: { id: true, user_id: true },
      orderBy: { id: "asc" },
      take: CANCEL_PAGE,
      ...(after ? { cursor: { id: after }, skip: 1 } : {}),
    })
    for (const row of page) ids.add(row.user_id)
    if (page.length < CANCEL_PAGE) return [...ids]
    after = page[page.length - 1].id
  }
}

/**
 * Tell the people who were inside that it is off, and that they are no longer
 * checked in (SV7). Their check-ins were just cancelled and nothing said so.
 *
 * ## Aggregate at concert scale
 *
 * One socket emit to the event's rooms (`event:cancelled`, `{ eventId }`), however many
 * are inside, and the push in batches of `CANCEL_PUSH_BATCH`: each batch is one
 * bell insert and one token read, and Expo's own chunking does the rest. No
 * per-person emit.
 *
 * ## One push, not two
 *
 * This push is `event_cancelled`. `notifyEventCancelled` skips these people, so
 * somebody who was inside AND going is told once, here.
 *
 * Never throws: the cancellation has committed and must not be undone by a
 * failed push. Nothing is sent when nobody was inside, so a second run over an
 * already-cancelled event (`inside` is empty) tells nobody twice.
 */
async function tellInsideCancelled(eventId: string, inside: readonly string[]): Promise<void> {
  if (inside.length === 0) return
  try {
    /*
     * Loaded here, not at the top: the pure helpers below (`isCancellingEvent`
     * and the rest) are imported by tests and by code that has no use for
     * socket.io and the mobile auth it pulls in (`jose` is ESM-only).
     */
    const [{ emitEventCancelled }, { sendBulkPushNotifications }] = await Promise.all([
      import("@/lib/socket-server"),
      import("@/lib/push-notifications"),
    ])
    emitEventCancelled(eventId)
    const event = await db.events.findUnique({ where: { id: eventId }, select: { title: true } })
    for (let i = 0; i < inside.length; i += CANCEL_PUSH_BATCH) {
      await sendBulkPushNotifications({
        userIds: inside.slice(i, i + CANCEL_PUSH_BATCH),
        title: event?.title ?? "Event cancelled",
        body: INSIDE_CANCELLED_BODY,
        data: { type: "event_cancelled", eventId },
      })
    }
    logger.info("Event cancellation told to those inside", { eventId, recipientCount: inside.length })
  } catch (error) {
    logger.error("Failed to tell those inside the event is cancelled", { eventId, error: String(error) })
  }
}

/** What the push says to someone who was inside. No name but the event's own. */
export const INSIDE_CANCELLED_BODY = "This event has been cancelled. You are no longer checked in."

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
 * The audit action for an event write, named by the transition it makes.
 *
 * Publish and cancel are the edits people outside the organisation feel, and
 * no event write but DELETE was audited (SCRUM-89). One answer for both doors,
 * the dashboard PATCH and the mobile one, as the cancel cascade already is.
 */
export function eventWriteAction(
  nextStatus: string | undefined,
  currentStatus: string
): "event.cancelled" | "event.published" | "event.updated" {
  if (isCancellingEvent(nextStatus, currentStatus)) return "event.cancelled"
  if (nextStatus === "published" && currentStatus !== "published") return "event.published"
  return "event.updated"
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
