import { db } from "@/lib/db"
import { logger } from "@/lib/logger"
import { emitChatMessageHidden, emitChatMemberMuted } from "@/lib/socket-server"
import { AUTO_MUTE_HIDDEN_COUNT, AUTO_MUTE_WINDOW_MS } from "./config"
import type { ModerationResult } from "./types"

/**
 * Hide a message: set moderation_status, soft-delete, and notify via socket.
 * The socket event includes userId so the client can show a "message removed"
 * placeholder to the sender instead of silently deleting it.
 */
export async function hideMessage(
  messageId: string,
  chatGroupId: string,
  userId: string,
  result: ModerationResult
): Promise<void> {
  try {
    await db.chat_messages.update({
      where: { id: messageId },
      data: {
        moderation_status: "hidden",
        deleted_at: new Date(),
      },
    })

    emitChatMessageHidden(chatGroupId, messageId, userId)

    logger.info("Message auto-hidden", {
      messageId,
      chatGroupId,
      userId,
      source: result.source,
      confidence: result.confidence,
    })
  } catch (error) {
    logger.error("Failed to hide message", { messageId, error: String(error) })
  }
}

/**
 * Create a moderation flag record for human review
 */
export async function flagForReview(
  messageId: string,
  chatGroupId: string,
  userId: string,
  result: ModerationResult
): Promise<void> {
  try {
    await db.$transaction([
      db.moderation_flags.create({
        data: {
          message_id: messageId,
          chat_group_id: chatGroupId,
          user_id: userId,
          source: mapSource(result.source),
          categories: result.categories,
          confidence: result.confidence,
          auto_action: result.action === "hide" ? "hidden" : "none",
        },
      }),
      db.chat_messages.update({
        where: { id: messageId },
        data: {
          moderation_status: result.action === "hide" ? "hidden" : "flagged",
        },
      }),
    ])

    logger.info("Message flagged for review", {
      messageId,
      chatGroupId,
      source: result.source,
      confidence: result.confidence,
    })
  } catch (error) {
    logger.error("Failed to flag message", { messageId, error: String(error) })
  }
}

/**
 * Check if a user should be auto-muted (3+ hidden messages in the last hour)
 * and apply mute if so.
 */
export async function checkAndAutoMute(
  userId: string,
  chatGroupId: string
): Promise<void> {
  try {
    const windowStart = new Date(Date.now() - AUTO_MUTE_WINDOW_MS)

    const hiddenCount = await db.moderation_flags.count({
      where: {
        user_id: userId,
        chat_group_id: chatGroupId,
        auto_action: "hidden",
        created_at: { gte: windowStart },
      },
    })

    if (hiddenCount >= AUTO_MUTE_HIDDEN_COUNT) {
      await db.chat_group_members.updateMany({
        where: {
          chat_group_id: chatGroupId,
          user_id: userId,
        },
        data: {
          status: "muted",
        },
      })

      emitChatMemberMuted(
        chatGroupId,
        userId,
        true,
        "Auto-muted due to repeated policy violations"
      )

      logger.warn("User auto-muted due to repeated violations", {
        userId,
        chatGroupId,
        hiddenCount,
      })
    }
  } catch (error) {
    logger.error("Failed to check/apply auto-mute", {
      userId,
      chatGroupId,
      error: String(error),
    })
  }
}

/**
 * Mark a message as clean (passed all moderation checks)
 */
export async function markClean(messageId: string): Promise<void> {
  try {
    await db.chat_messages.update({
      where: { id: messageId },
      data: { moderation_status: "clean" },
    })
  } catch (error) {
    logger.error("Failed to mark message clean", { messageId, error: String(error) })
  }
}

/**
 * Check if a muted user's mute should have expired.
 * Auto-mutes last for AUTO_MUTE_WINDOW_MS (1 hour). If the user's most recent
 * hidden message is older than that window, unmute them automatically.
 *
 * Returns true if the user was auto-unmuted (caller should proceed normally),
 * false if they should remain muted.
 */
export async function checkAndAutoUnmute(
  userId: string,
  chatGroupId: string
): Promise<boolean> {
  try {
    const windowStart = new Date(Date.now() - AUTO_MUTE_WINDOW_MS)

    // Count recent violations in the mute window
    const recentHiddenCount = await db.moderation_flags.count({
      where: {
        user_id: userId,
        chat_group_id: chatGroupId,
        auto_action: "hidden",
        created_at: { gte: windowStart },
      },
    })

    // If no recent violations, the mute window has passed — unmute
    if (recentHiddenCount < AUTO_MUTE_HIDDEN_COUNT) {
      await db.chat_group_members.updateMany({
        where: {
          chat_group_id: chatGroupId,
          user_id: userId,
          status: "muted",
        },
        data: {
          status: "active",
        },
      })

      emitChatMemberMuted(chatGroupId, userId, false, "Auto-mute expired")

      logger.info("User auto-unmuted after mute window expired", {
        userId,
        chatGroupId,
      })

      return true
    }

    return false
  } catch (error) {
    logger.error("Failed to check auto-unmute", {
      userId,
      chatGroupId,
      error: String(error),
    })
    return false
  }
}

/** Map internal source names to Prisma enum values */
function mapSource(
  source: ModerationResult["source"]
): "auto_text" | "auto_image" | "auto_spam" | "auto_keyword" {
  switch (source) {
    case "keyword":
      return "auto_keyword"
    case "openai_text":
      return "auto_text"
    case "openai_image":
      return "auto_image"
    case "spam":
      return "auto_spam"
  }
}
