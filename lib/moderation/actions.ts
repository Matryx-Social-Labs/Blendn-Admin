import { logger } from "@/lib/logger"
import { db } from "@/lib/db"
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
          muted_at: new Date(),
          // Null on purpose: null means automatic, and only an automatic mute
          // may be lifted by the timer below.
          muted_by: null,
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
 * Record what the pipeline actually did, which is not always what it found.
 *
 * `markClean` wrote `"clean"` for every message that reached the end of the
 * pipeline, including every message the model never saw -- no API key, an API
 * error, or a timeout in the inline path's race. `OPENAI_API_KEY` is optional in
 * `lib/env.ts` and listed as not required in `DEPLOYMENT.md`, so the ordinary
 * deployment recorded every message as moderated by a moderator that was never
 * called.
 *
 * `unchecked` is not a failure state to be hidden. It is the signal that the
 * pipeline is degraded, and it is rendered as a count on the moderation screen
 * -- which is the difference between a moderator knowing the model is down and a
 * moderator believing the room is quiet. R13.
 *
 * The message is delivered either way. Refusing to send because a third-party
 * API is unavailable is its own harm, and the deterministic checks (keyword,
 * spam, contact-info) have already run and cannot fail open.
 */
export async function recordExamined(messageId: string, examined: boolean): Promise<void> {
  try {
    await db.chat_messages.update({
      where: { id: messageId },
      data: { moderation_status: examined ? "clean" : "unchecked" },
    })
  } catch (error) {
    logger.error("Failed to record moderation outcome", { messageId, examined, error: String(error) })
  }
}

/**
 * Check if an **automatic** mute should have expired.
 *
 * Auto-mutes last for AUTO_MUTE_WINDOW_MS (1 hour). If the user's most recent
 * hidden message is older than that window, unmute them.
 *
 * ## Only automatic mutes
 *
 * This cleared *any* `muted` status from anyone with fewer than three recent
 * auto-hide flags. An organiser-applied mute has **zero** flags, so `0 < 3` was
 * true and the mute evaporated on the muted person's next message -- the
 * moderator's action visibly succeeded and then undid itself, with no record
 * that it had.
 *
 * `muted_by IS NULL` is the discriminator, mirroring `banned_by`. A human's
 * decision is undone by a human. The identical bug was found and fixed for bans
 * (see the auto-join comment in the event chat route), and the reasoning was
 * never carried across to mutes.
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
      const { count } = await db.chat_group_members.updateMany({
        where: {
          chat_group_id: chatGroupId,
          user_id: userId,
          status: "muted",
          // The whole fix: a mute somebody applied is not this timer's to lift.
          muted_by: null,
        },
        data: {
          status: "active",
          muted_at: null,
        },
      })

      // Nothing matched, so the mute was a human's. They stay muted, and the
      // caller must not be told they were released.
      if (count === 0) return false

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
