import { db } from "./db"

/**
 * Room-join authorization for Socket.io.
 *
 * These are the rules added in 7f7b673, extracted from the inline handlers in
 * socket-server.ts so they can be unit-tested without standing up a Socket.io
 * server. Semantics are unchanged — see __tests__/socket-auth.test.ts.
 *
 * All three take untrusted client input. The ID columns are `@db.Uuid`, so a
 * malformed ID makes Prisma throw rather than return null; callers must treat a
 * rejection as "denied" (see `guardJoin` in socket-server.ts) instead of letting
 * it escape as an unhandled rejection.
 */

/**
 * Chat rooms: caller must be a member and not banned.
 *
 * Note: the REST read path
 * (app/api/mobile/chat/groups/[chatGroupId]/messages/route.ts) still lets a
 * banned member read history — only writes are blocked there. This is stricter.
 */
export async function canJoinChat(userId: string, chatGroupId: string): Promise<boolean> {
  const membership = await db.chat_group_members.findUnique({
    where: {
      chat_group_id_user_id: { chat_group_id: chatGroupId, user_id: userId },
    },
    select: { status: true },
  })
  return membership !== null && membership.status !== "banned"
}

/**
 * Private conversations: only the two participants.
 */
export async function canJoinConversation(
  userId: string,
  conversationId: string
): Promise<boolean> {
  const conversation = await db.private_conversations.findUnique({
    where: { id: conversationId },
    select: { user1_id: true, user2_id: true, closed_at: true },
  })
  if (!conversation) return false
  // A closed conversation is not joinable. Without this, typing indicators and
  // read receipts keep flowing between two people after one of them unmatched
  // -- a live channel surviving the thing that was supposed to end it.
  if (conversation.closed_at) return false
  return conversation.user1_id === userId || conversation.user2_id === userId
}

/**
 * Event rooms carry check-in/check-out and interest updates — i.e. who is
 * physically at the event.
 *
 * Public and unlisted events stay open to any authenticated user: the mobile
 * client subscribes as soon as an event detail modal is opened, without
 * requiring a check-in, to drive the live attendee counter. Private events are
 * limited to the organizer and to users who RSVP'd.
 */
export async function canJoinEvent(userId: string, eventId: string): Promise<boolean> {
  const event = await db.events.findFirst({
    where: { id: eventId, deleted_at: null },
    select: { visibility: true, organizer_id: true },
  })
  if (!event) return false
  if (event.visibility !== "private") return true
  if (event.organizer_id === userId) return true

  // An RSVP only grants access if the user actually intends to attend.
  // `rsvp_status` includes `not_going`, and declining an invite must not hand
  // out a live feed of who else is at a private event.
  const rsvp = await db.event_rsvps.findFirst({
    where: {
      event_id: eventId,
      user_id: userId,
      status: { in: ["going", "maybe"] },
    },
    select: { id: true },
  })
  return rsvp !== null
}
