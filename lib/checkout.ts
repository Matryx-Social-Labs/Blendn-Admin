// Relative, not "@/lib/db". `build:server` compiles this with plain tsc, which
// resolves the @/ alias for typechecking and then emits it verbatim into the
// require() — the build goes green and the container dies on boot with
// MODULE_NOT_FOUND. This module is reachable from server.ts through the
// presence sweeper, so everything it imports must be relative too.
import { db } from "./db"
import { logger } from "./logger"
import { emitEventCheckOut } from "./socket-server"

/**
 * The one way someone stops being in the room.
 *
 * There were three: the manual checkout route, the branch in check-in that
 * closes your previous event, and (soon) the presence sweeper. Three
 * implementations of the same idea is how they drift — one forgets the chat
 * cutoff, another forgets the socket event, and nobody notices until an
 * organiser asks why a name is still in the list.
 *
 * Idempotent. A row that is already `checked_out` is left alone and reported as
 * such, which is what lets the sweeper run every fifteen minutes without
 * needing to know what the last pass did.
 */

export type CheckoutReason =
  | "manual"
  /** They checked in somewhere else; you cannot be in two rooms. */
  | "switched_event"
  /** Left the geofence and did not answer the prompt. */
  | "left_area"
  /** Still checked in when the day ended. */
  | "occurrence_ended"

export interface CheckoutResult {
  changed: boolean
  eventId: string
  userId: string
}

/**
 * Whether this kind of checkout also closes chat access.
 *
 * An automatic checkout does not. Someone whose GPS wandered while they were
 * mid-conversation should not be thrown out of the room as well — the feedback
 * window already governs when chat closes, and the cost of being wrong here is
 * much higher than a slightly stale attendee count.
 */
function cutsChatAccess(reason: CheckoutReason): boolean {
  return reason === "manual" || reason === "switched_event"
}

export async function performCheckout(
  checkInId: string,
  reason: CheckoutReason,
  now: Date = new Date()
): Promise<CheckoutResult | null> {
  const checkIn = await db.event_check_ins.findUnique({
    where: { id: checkInId },
    select: { id: true, event_id: true, user_id: true, status: true },
  })
  if (!checkIn) return null

  // Idempotent by design: the sweeper re-reads the same rows every pass.
  if (checkIn.status !== "checked_in") {
    return { changed: false, eventId: checkIn.event_id, userId: checkIn.user_id }
  }

  // Guarded in the statement rather than after the read above, so two callers
  // racing (a sweeper pass and a live manual checkout) cannot both act.
  const { count } = await db.event_check_ins.updateMany({
    where: { id: checkInId, status: "checked_in" },
    data: { status: "checked_out", check_out_time: now, updated_at: now },
  })
  if (count === 0) {
    return { changed: false, eventId: checkIn.event_id, userId: checkIn.user_id }
  }

  if (cutsChatAccess(reason)) {
    const chatGroup = await db.chat_groups.findUnique({
      where: { event_id: checkIn.event_id },
      select: { id: true },
    })
    if (chatGroup) {
      await db.chat_group_members.updateMany({
        where: { chat_group_id: chatGroup.id, user_id: checkIn.user_id },
        data: { last_allowed_at: now, updated_at: now },
      })
    }
  }

  // Emitted here rather than by each caller, so the sweeper cannot forget it
  // and leave the live screen showing someone who has gone.
  emitEventCheckOut(checkIn.event_id, checkIn.user_id)

  logger.info("Checked out", {
    checkInId,
    eventId: checkIn.event_id,
    reason,
    chatClosed: cutsChatAccess(reason),
  })

  return { changed: true, eventId: checkIn.event_id, userId: checkIn.user_id }
}

/**
 * Close whatever event this person is currently inside, other than `exceptEventId`.
 *
 * You cannot be in two rooms. Called by check-in before it opens a new one.
 */
export async function checkOutOfOtherEvents(
  userId: string,
  exceptEventId: string,
  now: Date = new Date()
): Promise<CheckoutResult[]> {
  const others = await db.event_check_ins.findMany({
    where: { user_id: userId, status: "checked_in", event_id: { not: exceptEventId } },
    select: { id: true },
  })

  const results: CheckoutResult[] = []
  for (const row of others) {
    const result = await performCheckout(row.id, "switched_event", now)
    if (result) results.push(result)
  }
  return results
}
