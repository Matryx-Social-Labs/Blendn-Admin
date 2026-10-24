import { db } from "@/lib/db"
import { logger } from "@/lib/logger"
import { hereCountFor } from "@/lib/attendee-counts"
import { moderationUnavailableResponse } from "@/lib/api-response"
import { breakerIsOpen } from "./text-breaker"
import type { ModerationCheck } from "./openai-moderation"

/**
 * What a send does when OpenAI gives no verdict (moderation-degraded policy).
 *
 * A small room still delivers the line unchecked and the re-check sweeper looks
 * again later. A BIG event room does not: past `BIG_ROOM_HERE_COUNT` people
 * inside, an unscreened line reaches the most people at the moment (a concert
 * flood) the vendor is most likely to be 429ing. No verdict, no message.
 *
 * Both send routes use these two steps, so a third cannot pick its own rule.
 * Only event rooms are asked: `eventId` is null for every other kind.
 */

/** The owner-approved slow-mode tier boundary (load-and-concert-plan Q1: 200 and under is the 3 s tier). */
export const BIG_ROOM_HERE_COUNT = 200
export const MODERATION_RETRY_AFTER_SECONDS = 5
export const MODERATION_UNAVAILABLE_MESSAGE =
  "This room is busy and messages can’t be checked right now. Try again in a few seconds."

/** One count, and only ever on the failure path. */
async function isBigRoom(eventId: string | null): Promise<boolean> {
  return eventId !== null && (await hereCountFor(eventId)) > BIG_ROOM_HERE_COUNT
}

/** The 503 a refused send answers with (also a retry of a held row, `lib/room-retry.ts`). */
export const moderationRefusal = () =>
  moderationUnavailableResponse(MODERATION_UNAVAILABLE_MESSAGE, MODERATION_RETRY_AFTER_SECONDS)

/** Before the row is written: the breaker is open and the room is big, so do not even try. */
export async function refuseBigRoomWhileDown(eventId: string | null): Promise<Response | null> {
  if (!breakerIsOpen() || !(await isBigRoom(eventId))) return null
  return moderationRefusal()
}

/** What a send does next. `removed`: somebody deleted the row during the wait; do not emit it. */
export type BigRoomOutcome =
  | { kind: "proceed"; check: ModerationCheck }
  | { kind: "refuse" }
  | { kind: "removed" }

/**
 * The 1 s race produced `check`. Says what the route does next.
 *
 * A missing key is configuration, not an outage, and a checked answer is an
 * answer. Otherwise a big room keeps waiting for the call already in flight
 * (it has its own 8 s deadline); a small room carries on as before. Anything
 * that throws on a room that may be big (the count, the hold) refuses: this
 * path never delivers a line nobody could check.
 *
 * While it waits the row is soft-deleted (`deleted_at`), which every room
 * reader already excludes (history, last-message previews, unread and total
 * counts). The hold starts AFTER the 1 s race, so for up to about a second the
 * line is readable like any other room line (the send overlaps moderation with
 * the write; closing that would cost a write per send). A hide verdict leaves
 * the row held (`hideMessage` follows). Any other verdict releases it only if
 * it still carries THIS hold (`deleted_at` equals what we wrote): a moderator or
 * the sender who deleted it meanwhile is not undone.
 */
export async function verdictForBigRoom(
  eventId: string | null,
  messageId: string,
  check: ModerationCheck,
  pendingText: Promise<ModerationCheck>
): Promise<BigRoomOutcome> {
  if (check.checked || check.reason === "no_key" || eventId === null) return { kind: "proceed", check }
  try {
    if (!(await isBigRoom(eventId))) return { kind: "proceed", check }
    const heldAt = new Date()
    const held = await db.chat_messages.updateMany({ where: { id: messageId, deleted_at: null }, data: { deleted_at: heldAt } })
    if (held.count === 0) return { kind: "removed" }
    const settled = await pendingText
    if (!settled.checked) return { kind: "refuse" }
    if (settled.result?.action === "hide") return { kind: "proceed", check: settled }
    const released = await db.chat_messages.updateMany({ where: { id: messageId, deleted_at: heldAt }, data: { deleted_at: null } })
    return released.count === 0 ? { kind: "removed" } : { kind: "proceed", check: settled }
  } catch (error) {
    logger.error("Big-room moderation hold failed; refusing the send", { messageId, error: String(error) })
    return { kind: "refuse" }
  }
}

/**
 * Take the just-written row back and refuse. Nothing was emitted, so no other
 * screen saw it, and the sender's retry (same `clientId`) is free to write again.
 */
export async function discardAndRefuse(messageId: string): Promise<Response> {
  await db.chat_messages.delete({ where: { id: messageId } }).catch((error: unknown) =>
    logger.error("Could not discard an unchecked message in a big room", { messageId, error: String(error) })
  )
  return moderationRefusal()
}
