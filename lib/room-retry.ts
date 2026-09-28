import { db } from "@/lib/db"
import { errorResponse, successResponse } from "@/lib/api-response"

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
    select: { id: true, chat_group_id: true, type: true, content: true, moderation_status: true, created_at: true, client_id: true },
  })
}

export function answerRoomRetry(
  existing: NonNullable<Awaited<ReturnType<typeof findRoomSend>>>,
  chatGroupId: string
) {
  if (existing.chat_group_id !== chatGroupId) {
    return errorResponse("That message id belongs to another room", 409)
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
