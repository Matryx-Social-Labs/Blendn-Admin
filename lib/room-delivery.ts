import { logger } from "@/lib/logger"
import { db } from "@/lib/db"
import { blockCounterparties } from "@/lib/conversations"
import { emitChatMessage } from "@/lib/socket-server"
import { notifyRoomReply } from "@/lib/push-notifications"
import { roomHandle } from "@/lib/room-handle"
import { isRoomMuted } from "@/lib/room-mute"

/**
 * Getting a message to the room. One implementation, because there were two
 * write paths and only one of them did it.
 *
 * ## The bug
 *
 * `POST /events/:id/chat` persisted a message and stopped. No socket emit, no
 * push. So a message sent from the event chat screen was **invisible to
 * everyone else until they re-polled** — which for anyone with the room already
 * open meant it simply never arrived. The sibling endpoint,
 * `POST /chat/groups/:id/messages`, writing to the same `chat_messages` table
 * for the same group, has always done both.
 *
 * Copying the block would have made two paths that both deliver, which is
 * better and still two. This is the shared half, and it is the shape §4b of the
 * rebuild plan calls `postToRoom`: delivery is part of the write, not an
 * optional postscript.
 *
 * ## Blocks are resolved once
 *
 * Both the socket emit and the reply push filter on the same set, and the
 * REST history filters on it too — so the three surfaces cannot disagree about
 * who is in the room. Fetching it twice would be how they start to.
 *
 * ## Never throws
 *
 * The message is already committed by the time this runs. A failed push must
 * not turn a delivered message into a 500 for the sender, and a failed emit
 * must not stop the push. Both are logged.
 */
export async function deliverToRoom(input: {
  chatGroupId: string
  /** The room's event: the push names the sender by their handle in it. */
  eventId: string
  groupName: string | null
  senderId: string
  senderAnonName: string
  message: {
    id: string
    content: string
    type: string
    user_id: string
    created_at: Date
    parent_id?: string | null
  }
  /** What the lock screen says. Not the content for anything but text. */
  preview: string
}): Promise<void> {
  const { chatGroupId, senderId, senderAnonName, message } = input

  let senderBlocked: string[] = []
  try {
    senderBlocked = await blockCounterparties(senderId)
  } catch (error) {
    /*
     * Fail **closed on delivery**, not open.
     *
     * If we cannot tell who has blocked this sender, pushing to everyone would
     * put a blocked person's message on somebody's lock screen — the exact harm
     * the filter exists for. Skipping delivery costs a message that appears on
     * the next poll; getting it wrong costs the thing block means.
     */
    logger.error("Room delivery skipped: could not resolve blocks", {
      chatGroupId,
      error: error instanceof Error ? error.message : String(error),
    })
    return
  }

  try {
    emitChatMessage(
      chatGroupId,
      {
        id: message.id,
        content: message.content,
        type: message.type,
        userId: message.user_id,
        userName: senderAnonName,
        userImage: undefined,
        createdAt: message.created_at.toISOString(),
        parentId: message.parent_id || undefined,
      },
      senderBlocked,
      input.eventId
    )
  } catch (error) {
    logger.error("Room socket emit failed", {
      chatGroupId,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  /*
   * The push goes to one person or nobody: the author of the message this one
   * replies to. Every other room message is for whoever has the room open —
   * see `notifyRoomReply` for why the room stopped pushing to everyone.
   */
  if (!message.parent_id) return

  try {
    const parent = await db.chat_messages.findUnique({
      where: { id: message.parent_id },
      select: { user_id: true },
    })
    const recipientId = parent?.user_id
    // A lock screen is the loudest surface in the product. Somebody in a block
    // with this sender must not get a notification from them.
    if (!recipientId || recipientId === senderId || senderBlocked.includes(recipientId)) return

    // Still in the room: `left` and `banned` are gone, `muted` still reads.
    const membership = await db.chat_group_members.findUnique({
      where: { chat_group_id_user_id: { chat_group_id: chatGroupId, user_id: recipientId } },
      select: { status: true, notification_preferences: true },
    })
    if (membership?.status !== "active" && membership?.status !== "muted") return
    // And they have not silenced the room (`POST /chat/groups/:id/mute`).
    if (isRoomMuted(membership.notification_preferences)) return

    await notifyRoomReply({
      recipientId,
      senderName: senderAnonName,
      groupName: input.groupName || "Group Chat",
      preview: input.preview,
      chatGroupId,
      senderHandle: roomHandle(input.eventId, senderId),
    })
  } catch (error) {
    logger.error("Room push notification failed", {
      chatGroupId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/** What a lock screen shows for a message of this type. */
export function previewFor(type: string, content: string): string {
  if (type === "image") return "📷 Photo"
  if (type === "video") return "🎥 Video"
  return content
}
