import { ErrorCode, errorResponse } from "@/lib/api-response"
import { bannedRefusal } from "@/lib/chat-window"
import { resolveUserRef } from "@/lib/room-handle"
import { eventRoomBan } from "@/lib/room-kind"

/**
 * A member a host banned from an event's room is out of the room's people
 * too, not only its chat (security review, SV6). A check-in alone used to let
 * them read the roster, the deck and the night's people, wave, like, reveal,
 * rate and open the profiles behind the room's handles; the ban stopped only
 * their posts. Every event-scoped people read and write asks here, and answers
 * as the chat does: `bannedRefusal`, 403 `USER_BANNED`, word for word.
 *
 * Route-side (it builds a response); the predicate itself is `eventRoomBan`
 * in lib/room-kind.ts, which the server's sweepers can reach.
 */
export async function roomBanRefusal(eventId: string, userId: string) {
  const ban = await eventRoomBan(eventId, userId)
  return ban ? errorResponse(bannedRefusal(ban), 403, ErrorCode.USER_BANNED) : null
}

/**
 * The same, for a ref: an event room's handle carries its room, and a viewer
 * banned there gets the chat's answer. A raw id carries no room — whoever
 * holds one did not get it from that room — and is not asked about.
 */
export async function refRoomBanRefusal(ref: string, userId: string) {
  const eventId = resolveUserRef(ref)?.eventId
  return eventId ? roomBanRefusal(eventId, userId) : null
}
