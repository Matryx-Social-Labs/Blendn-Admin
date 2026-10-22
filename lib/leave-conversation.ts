import type { Prisma } from "@prisma/client"
import { closeConversation } from "@/lib/conversations"
import { dropCrewInvitesBetween } from "@/lib/crews/blocks"
import { lockPair, severFriendship } from "@/lib/friends"

/**
 * One person leaves a conversation: an unmatch, or a block. The app's only door
 * is `POST /conversations/:id/leave`; `DELETE /conversations/:id` is the older
 * one. Both close through here, so they cannot disagree about what leaving does.
 *
 * Inside the caller's transaction, and **first the pair's lock** — the one a
 * friend request, an accept and a block already take (`lockPair`) — so a request
 * racing this either lands before it (and a block severs it below) or sees the
 * conversation closed and is refused.
 *
 * - `unmatch` closes the conversation. A friendship is left standing:
 *   unfriending is not blocking.
 * - `block` also records the block, cancels message requests either way, and
 *   severs the friendship with any friend request, exactly as
 *   `POST /users/:id/block` does. A block that left the friendship would keep
 *   the blocked person on the blocker's list, one tap from a DM — and bring it
 *   back on an unblock.
 */
export async function leaveConversationIn(
  tx: Prisma.TransactionClient,
  leaver: { conversationId: string; userId: string; otherId: string; action: "unmatch" | "block" }
): Promise<void> {
  const { conversationId, userId, otherId, action } = leaver
  await lockPair(tx, userId, otherId)
  // Idempotent, and scoped by `closed_at: null`, so a retry never rewrites who left or when.
  await closeConversation(conversationId, userId, action, tx)

  if (action === "block") {
    await tx.blocked_users.upsert({
      where: { blocker_id_blocked_id: { blocker_id: userId, blocked_id: otherId } },
      create: { blocker_id: userId, blocked_id: otherId },
      update: {},
    })
    // Both directions: a request either of them left pending must not survive
    // to be accepted into a conversation between blocked people.
    await tx.message_requests.updateMany({
      where: {
        status: "pending",
        OR: [
          { sender_id: otherId, recipient_id: userId },
          { sender_id: userId, recipient_id: otherId },
        ],
      },
      data: { status: "blocked" },
    })
    // The friendship, any friend request, and any crew invite between them.
    await severFriendship(userId, otherId, tx)
    return
  }
  // Leaving is permanent either way, so a crew invite between them goes too
  // (C5/C6): a closed pair is kept apart on every crew surface.
  await dropCrewInvitesBetween(tx, userId, otherId)
}
