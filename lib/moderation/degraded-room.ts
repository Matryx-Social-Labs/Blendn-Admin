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

const refusal = () => moderationUnavailableResponse(MODERATION_UNAVAILABLE_MESSAGE, MODERATION_RETRY_AFTER_SECONDS)

/** Before the row is written: the breaker is open and the room is big, so do not even try. */
export async function refuseBigRoomWhileDown(eventId: string | null): Promise<Response | null> {
  if (!breakerIsOpen() || !(await isBigRoom(eventId))) return null
  return refusal()
}

/**
 * The 1 s race produced `check`. Returns the check to carry on with, or null
 * when the send must be refused.
 *
 * A missing key is configuration, not an outage, and a checked answer is an
 * answer. Otherwise a big room keeps waiting for the call already in flight
 * (it has its own 8 s deadline); a small room carries on as before.
 *
 * While it waits the row is soft-deleted (`deleted_at`), which is what every
 * room reader already excludes (history, last-message previews, unread and
 * total counts), so nobody else can read a line that has not been checked. A
 * hide verdict leaves it that way (`hideMessage` follows); any other verdict
 * puts it back before the caller emits. If it cannot be put back, refuse.
 */
export async function verdictForBigRoom(
  eventId: string | null,
  messageId: string,
  check: ModerationCheck,
  pendingText: Promise<ModerationCheck>
): Promise<ModerationCheck | null> {
  if (check.checked || check.reason === "no_key") return check
  if (!(await isBigRoom(eventId))) return check
  await db.chat_messages.update({ where: { id: messageId }, data: { deleted_at: new Date() } })
  const settled = await pendingText
  if (!settled.checked) return null
  if (settled.result?.action === "hide") return settled
  try {
    await db.chat_messages.update({ where: { id: messageId }, data: { deleted_at: null } })
  } catch (error) {
    logger.error("Could not release a held message in a big room", { messageId, error: String(error) })
    return null
  }
  return settled
}

/**
 * Take the just-written row back and refuse. Nothing was emitted, so no other
 * screen saw it, and the sender's retry (same `clientId`) is free to write again.
 */
export async function discardAndRefuse(messageId: string): Promise<Response> {
  await db.chat_messages.delete({ where: { id: messageId } }).catch((error: unknown) =>
    logger.error("Could not discard an unchecked message in a big room", { messageId, error: String(error) })
  )
  return refusal()
}
