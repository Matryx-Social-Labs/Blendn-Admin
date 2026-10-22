import { db } from "@/lib/db"
import { openRoomHandle } from "@/lib/room-handle"

export { idInConversation } from "@/lib/conversation-handle"

/**
 * The person a ref names, when it is a conversation handle the viewer holds:
 * the OTHER participant of that conversation, for one of its two people. Null
 * for anything else — a raw id, a room's handle, a forged or another
 * conversation's handle, one that names the viewer — which the caller handles as
 * it always has (usually: an id nobody has).
 *
 * Closed conversations still resolve: a block or a report after leaving is the
 * point of keeping the row.
 */
export async function userIdFromDmRef(viewerId: string, ref: string): Promise<string | null> {
  const opened = openRoomHandle(ref)
  if (!opened || typeof opened.scope === "string" || opened.scope.kind !== "dm") return null
  const conversation = await db.private_conversations.findUnique({
    where: { id: opened.scope.groupId },
    select: { user1_id: true, user2_id: true },
  })
  if (!conversation) return null
  const other = conversation.user1_id === viewerId ? conversation.user2_id : conversation.user2_id === viewerId ? conversation.user1_id : null
  return other !== null && other === opened.userId ? other : null
}
