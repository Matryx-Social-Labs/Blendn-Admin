import { db } from "./db"
import { roomReadDenial } from "./chat-window"
import { actorFor } from "./org-membership"
import { eventPermissionSelect, eventPermissions } from "./rbac"

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
 * Chat rooms: the same read rule as every HTTP read of the room —
 * `roomReadDenial` in lib/chat-window.ts (SCRUM-205).
 */
export async function canJoinChat(userId: string, chatGroupId: string): Promise<boolean> {
  const membership = await db.chat_group_members.findUnique({
    where: {
      chat_group_id_user_id: { chat_group_id: chatGroupId, user_id: userId },
    },
    // A hidden event has no room (SCRUM-8): its organiser's suspension flips
    // it to `draft`, and a draft never legitimately has a joinable chat.
    select: { status: true, chat_group: { select: { event: { select: { status: true, deleted_at: true } } } } },
  })
  if (!membership) return false
  return roomReadDenial(membership, membership.chat_group.event) === null
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
 * The **counter** room. Aggregates only — no identity, ever.
 *
 * Public and unlisted events stay open to any authenticated user: the mobile
 * client subscribes as soon as an event detail modal is opened, without
 * requiring a check-in, to drive the live attendee counter. Private events are
 * limited to the organizer and to users who RSVP'd.
 *
 * ## What this room used to carry, and why that was the leak
 *
 * `emitEventCheckIn` broadcast `{ real userId, pseudonym }` in here. Since any
 * authenticated user may join any public event, anyone could sit in every room
 * on the platform and harvest the pseudonym-to-user-id mapping for everybody who
 * checked in — which is precisely the cross-event correlation the pseudonyms
 * exist to prevent, plus a record of which real accounts attended which events.
 *
 * The REST twin of this hole was closed: `GET /events/:id/checkins` answers
 * *"Check in to see who else is here"* with a 403. The socket side kept
 * broadcasting the same information to strangers.
 *
 * The roster now lives in `canJoinEventRoom` below, and this room carries a
 * bare count. That split is not new — `event:ops:{id}` was separated from this
 * room for the same reason, with a comment saying so.
 */
export async function canJoinEvent(userId: string, eventId: string): Promise<boolean> {
  const event = await db.events.findFirst({
    where: { id: eventId, deleted_at: null },
    select: { visibility: true, status: true, organizer_id: true, ...eventPermissionSelect },
  })
  if (!event) return false
  // A hidden event has no counter either (SCRUM-8) — see `canJoinChat`.
  if (event.status === "draft") return false
  if (event.visibility !== "private") return true

  /*
   * Staff access is organisation-shaped, like everywhere else: a colleague at
   * the organisation running the event, or at the venue hosting it, operates
   * it and may watch its counter. `organizer_id` stays as the legacy creator
   * fallback `visibleEventsWhere` keeps for the same reason — a row created
   * before organisations existed must not vanish from its creator — and goes
   * when that one does. This function is now also what `attendeeEventAccess`
   * asks about a private event, so answering by creator alone would have told
   * the creator's own colleagues "not found" through the mobile API.
   */
  if (event.organizer_id === userId) return true
  const user = await db.user.findUnique({ where: { id: userId }, select: { role: true } })
  if (user && eventPermissions(await actorFor({ id: userId, role: user.role }), event).canOperate) {
    return true
  }

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

/**
 * The **roster** room. Who is here, by pseudonym.
 *
 * Membership is the same predicate the REST roster uses: you have a check-in
 * row for this event. Not an RSVP and not curiosity — the room is for the
 * people in it, which is the premise the whole product rests on.
 *
 * Checked-out attendees keep their seat deliberately. `GET .../checkins`
 * already draws that line: it lists `status: "checked_in"` while matches select
 * on `check_in_time IS NOT NULL`, because "was here" and "is here" are
 * different questions. Someone who stepped out and is still talking to the room
 * should not have the roster go silent on them.
 */
export async function canJoinEventRoom(userId: string, eventId: string): Promise<boolean> {
  const checkIn = await db.event_check_ins.findFirst({
    // `status` on the event, not the check-in: a hidden event's roster
    // closes with the rest of it (SCRUM-8).
    where: { event_id: eventId, user_id: userId, check_in_time: { not: null }, event: { status: { not: "draft" } } },
    select: { id: true },
  })
  return checkIn !== null
}
