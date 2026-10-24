import { db } from "@/lib/db"
import { errorResponse, successResponse } from "@/lib/api-response"
import { moderationRefusal } from "@/lib/moderation/degraded-room"
import { HELD_ROW_STALE_MS, isHeldRow } from "@/lib/moderation/held-row"

/*
 * A room send retried after a lost response (SCRUM-410). Both room write paths
 * — `POST /chat/groups/:id/messages` and `POST /events/:id/chat` — answer the
 * retry with the first write instead of writing a second. The first write's
 * full copy reached the room by socket; the app matches the retry by id.
 */
/** A room send already written under this client id, if any. */
export function findRoomSend(userId: string, clientId: string) {
  return db.chat_messages.findUnique({
    where: { user_id_client_id: { user_id: userId, client_id: clientId } },
    select: {
      id: true, chat_group_id: true, type: true, content: true, moderation_status: true, created_at: true, client_id: true,
      deleted_at: true, deleted_by: true,
    },
  })
}

export async function answerRoomRetry(
  existing: NonNullable<Awaited<ReturnType<typeof findRoomSend>>>,
  chatGroupId: string
) {
  if (existing.chat_group_id !== chatGroupId) {
    return errorResponse("That message id belongs to another room", 409)
  }
  /*
   * A row held for its text check (big room, OpenAI down) is neither sent nor
   * refused yet: "sent" would lose the line. Answer it as the send is answered.
   * One older than the hold window is abandoned (its request died); take it
   * away so the resend is clean.
   */
  if (isHeldRow(existing)) {
    if (Date.now() - existing.deleted_at!.getTime() > HELD_ROW_STALE_MS) {
      await db.chat_messages.deleteMany({ where: { id: existing.id, deleted_at: existing.deleted_at, deleted_by: null, moderation_status: null } })
    }
    return moderationRefusal()
  }
  const hidden = existing.moderation_status === "hidden"
  return successResponse({
    id: existing.id,
    type: existing.type,
    content: hidden ? null : existing.content,
    ...(hidden && { moderation_hidden: true }),
    clientId: existing.client_id,
    createdAt: existing.created_at.toISOString(),
  })
}
