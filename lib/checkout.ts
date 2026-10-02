// Relative, not "@/lib/db". `build:server` compiles this with plain tsc, which
// resolves the @/ alias for typechecking and then emits it verbatim into the
// require() — the build goes green and the container dies on boot with
// MODULE_NOT_FOUND. This module is reachable from server.ts through the
// presence sweeper, so everything it imports must be relative too.
import { db } from "./db"
import { closeSession } from "./presence-sessions"
import { logger } from "./logger"
import { emitEventCheckOut, evictFromVenueDay } from "./socket-server"

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
  /**
   * A Go Live window ran out, the venue's day reset under it (D-4), or both.
   * Stamped at `expires_at`, not when the sweeper got there (PL-U04).
   */
  | "expired"
  /** A real event started at the venue, and the venue's room is the event's now. */
  | "event_started"

const DEPARTURE_SOURCE: Record<CheckoutReason, "user" | "switch" | "sweeper" | "expired" | "ended"> = {
  manual: "user",
  switched_event: "switch",
  left_area: "sweeper",
  occurrence_ended: "sweeper",
  // Observed, not inferred: the window had a known end (F6).
  expired: "expired",
  // Known too: the event's start, which closed the venue's room.
  event_started: "ended",
}

export interface CheckoutResult {
  changed: boolean
  eventId: string
  userId: string
}

/**
 * Whether this kind of checkout also closes chat access.
 *
 * At an event, an automatic checkout does not. Someone whose GPS wandered while
 * they were mid-conversation should not be thrown out of the room as well — the
 * feedback window already governs when chat closes, and the cost of being wrong
 * here is much higher than a slightly stale attendee count. (The cut it writes,
 * `last_allowed_at`, is not read for an event's room any more: see
 * `mayWriteToRoom`.)
 *
 * At a venue day, every checkout does, and the cut is read: the room is for the
 * people live in it (`liveInVenueDay`), and leaving it however you leave ends
 * your window (F6).
 */
function cutsChatAccess(reason: CheckoutReason, venueDay: boolean): boolean {
  return venueDay || reason === "manual" || reason === "switched_event"
}

export async function performCheckout(
  checkInId: string,
  reason: CheckoutReason,
  now: Date = new Date()
): Promise<CheckoutResult | null> {
  const checkIn = await db.event_check_ins.findUnique({
    where: { id: checkInId },
    select: {
      id: true,
      event_id: true,
      user_id: true,
      status: true,
      occurrence_id: true,
      event: { select: { kind: true } },
    },
  })
  if (!checkIn) return null
  const venueDay = checkIn.event.kind === "venue_day"

  // Idempotent by design: the sweeper re-reads the same rows every pass.
  if (checkIn.status !== "checked_in") {
    return { changed: false, eventId: checkIn.event_id, userId: checkIn.user_id }
  }

  // Guarded in the statement rather than after the read above, so two callers
  // racing (a sweeper pass and a live manual checkout) cannot both act.
  const { count } = await db.event_check_ins.updateMany({
    where: {
      id: checkInId,
      status: "checked_in",
      // An expiry acts only on the window it read: going live again in between
      // moved `expires_at` past it, and that window is not over. Below the
      // next millisecond, not at it: Postgres keeps microseconds and a JS Date
      // does not, so a row ending at .000500 read back as .000 would never
      // match `lte` and would sit first in the sweep's queue for ever.
      ...(reason === "expired" && { expires_at: { lt: new Date(now.getTime() + 1) } }),
    },
    data: { status: "checked_out", check_out_time: now, updated_at: now },
  })
  if (count === 0) {
    return { changed: false, eventId: checkIn.event_id, userId: checkIn.user_id }
  }

  /*
   * Close the presence session too, in the one place both callers pass through.
   *
   * Written here rather than in the route because the sweeper checks people out
   * as well, and the comment above already says these two must not drift. A
   * session left open by a checkout is somebody who counts as present forever,
   * which is the bug the sessions model exists to make unrepresentable.
   *
   * Recording how lets the occupancy figure say how confident it is instead of
   * presenting inference as observation. Observed: `manual` (they checked out)
   * and a switch (they checked in somewhere else, at a known instant). Inferred:
   * leaving the fence and staying out, and the event's end. The sweeper closes
   * someone who never checked out an hour after the end, and when they really
   * left is a guess, so `occurrence_ended` is `sweeper`, not `ended`, and
   * `departureQuality` counts it as inference (SCRUM-484).
   */
  await closeSession(checkIn.occurrence_id, checkIn.user_id, DEPARTURE_SOURCE[reason], now)

  if (cutsChatAccess(reason, venueDay)) {
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
    if (venueDay) evictFromVenueDay(checkIn.event_id, chatGroup?.id ?? null, checkIn.user_id, reason)
  }

  // Emitted here rather than by each caller, so the sweeper cannot forget it
  // and leave the live screen showing someone who has gone.
  emitEventCheckOut(checkIn.event_id, checkIn.user_id)

  logger.info("Checked out", {
    checkInId,
    eventId: checkIn.event_id,
    reason,
    chatClosed: cutsChatAccess(reason, venueDay),
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
    select: { id: true, expires_at: true },
  })

  const results: CheckoutResult[] = []
  for (const row of others) {
    // A Go Live that already ran out ended then, not now, and not by a switch:
    // the sweeper had not got to it yet (D-4).
    const result =
      row.expires_at && row.expires_at <= now
        ? await performCheckout(row.id, "expired", row.expires_at)
        : await performCheckout(row.id, "switched_event", now)
    if (result) results.push(result)
  }
  return results
}
