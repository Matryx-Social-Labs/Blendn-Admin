import { displayNameInConversation, mayShowRealName } from "@/lib/conversation-identity"
import { db } from "@/lib/db"
import { logger } from "@/lib/logger"
import { emitRoomMatch } from "@/lib/socket-server"

/**
 * Tell both people, live, that a like just became mutual.
 *
 * `POST /matches/likes` answers the person who tapped and `notifyMatch` pushes
 * the earlier liker with a body that names nobody. This is the in-app half:
 * the Room is open on both phones more often than not, and a match that only
 * arrives by push or on the next refresh is a match that happened somewhere
 * else.
 *
 * Each side is named through `displayNameInConversation` on the conversation
 * row itself, not on pseudonyms read separately. The row is the authority: a
 * pair who already had a message-request conversation keep it
 * (`openConversation` does not backfill), and there they already see each
 * other's real names. Real names are loaded only for a side that rule says may
 * be shown, so an unearned name is never even read, let alone sent — and no
 * photo is sent at all.
 *
 * A separate module rather than a line in `likeAtEvent`, so the matching
 * library does not pull the socket server (and its JWT verifier) into
 * everything that ranks a room.
 *
 * Never rejects: it runs after the like has committed, and a failed emit must
 * not turn a match into a 500.
 */
export async function announceRoomMatch(eventId: string, conversationId: string): Promise<void> {
  try {
    const conversation = await db.private_conversations.findUnique({
      where: { id: conversationId },
      select: {
        user1_id: true,
        user2_id: true,
        user1_pseudonym: true,
        user2_pseudonym: true,
        user1_revealed: true,
        user2_revealed: true,
      },
    })
    if (!conversation) return

    const shown = [conversation.user1_id, conversation.user2_id].filter((id) =>
      mayShowRealName(conversation, id)
    )
    const users = shown.length
      ? await db.user.findMany({ where: { id: { in: shown } }, select: { id: true, name: true } })
      : []
    const realName = new Map(users.map((u) => [u.id, u.name]))
    // `name` is how THIS participant appears to the other one.
    const side = (userId: string) => ({
      userId,
      name: displayNameInConversation(conversation, userId, realName.get(userId)),
    })

    emitRoomMatch({
      eventId,
      conversationId,
      a: side(conversation.user1_id),
      b: side(conversation.user2_id),
    })
  } catch (error) {
    logger.warn("room:match emit failed", {
      eventId,
      conversationId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
