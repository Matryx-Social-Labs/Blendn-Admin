import { logger } from "@/lib/logger"
import { db } from "@/lib/db"
import { blockCounterparties } from "@/lib/conversations"
import { emitChatMessage } from "@/lib/socket-server"
import { notifyGroupMessage } from "@/lib/push-notifications"

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
 * Both the socket emit and the push fan-out filter on the same set, and the
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
      senderBlocked
    )
  } catch (error) {
    logger.error("Room socket emit failed", {
      chatGroupId,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  try {
    const members = await db.chat_group_members.findMany({
      where: {
        chat_group_id: chatGroupId,
        status: "active",
        // A lock screen is the loudest surface in the product. Somebody who
        // blocked this sender must not get a notification from them.
        ...(senderBlocked.length ? { user_id: { notIn: senderBlocked } } : {}),
      },
      select: { user_id: true },
    })

    await notifyGroupMessage(
      members.map((m) => m.user_id),
      senderAnonName,
      input.groupName || "Group Chat",
      input.preview,
      chatGroupId,
      senderId
    )
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
