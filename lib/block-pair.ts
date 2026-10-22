import type { Prisma } from "@prisma/client"
import { closeConversation, conversationPair } from "@/lib/conversations"
import { lockPair, severFriendship } from "@/lib/friends"

/**
 * ONE block, whichever door it came through.
 *
 * Four doors write a block: `POST /users/:id/block`, a DM's `/leave` with
 * `block`, a message request's `block` response, and the board's block (which
 * is the first one). They each did their own part of "block means block", and
 * each missed a different part — a request-block left the friendship and the
 * conversation standing. So there is one helper, inside the caller's
 * transaction, and the doors differ only in what they add around it.
 *
 * Under the pair's lock first (`lockPair`), so an accept, a request or a release
 * in flight either finishes before the block (and is severed here) or sees it.
 * Then, all idempotent:
 *
 * - the block row;
 * - message requests either way, cancelled;
 * - the friendship and every friend request either way (held ones included),
 *   and any crew invite between them (`severFriendship`);
 * - the conversation, closed (a block implies an unmatch, and unmatching is
 *   permanent).
 *
 * Returns the id of the conversation it closed, for the caller to evict from
 * the socket room after the commit; null if there was none or it was closed.
 */
export async function blockPairIn(tx: Prisma.TransactionClient, blockerId: string, blockedId: string): Promise<string | null> {
  await lockPair(tx, blockerId, blockedId)
  await tx.blocked_users.upsert({
    where: { blocker_id_blocked_id: { blocker_id: blockerId, blocked_id: blockedId } },
    create: { blocker_id: blockerId, blocked_id: blockedId },
    update: {},
  })
  // Both directions: a request either of them left pending must not survive to
  // be accepted into a conversation between blocked people.
  await tx.message_requests.updateMany({
    where: {
      status: "pending",
      OR: [
        { sender_id: blockedId, recipient_id: blockerId },
        { sender_id: blockerId, recipient_id: blockedId },
      ],
    },
    data: { status: "blocked" },
  })
  await severFriendship(blockerId, blockedId, tx)

  const [user1_id, user2_id] = conversationPair(blockerId, blockedId)
  const conversation = await tx.private_conversations.findUnique({
    where: { user1_id_user2_id: { user1_id, user2_id } },
    select: { id: true, closed_at: true },
  })
  if (!conversation || conversation.closed_at) return null
  await closeConversation(conversation.id, blockerId, "block", tx)
  return conversation.id
}
