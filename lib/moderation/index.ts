import { checkKeywords } from "./keyword-filter"
import { checkTextContent, checkImageContent } from "./openai-moderation"
import { hideMessage, flagForReview, checkAndAutoMute, markClean } from "./actions"
import { logger } from "@/lib/logger"

/**
 * Main moderation orchestrator.
 * Runs asynchronously after a message is saved and emitted via socket.
 *
 * Pipeline:
 * 1. Keyword filter (sync, <1ms)
 * 2. OpenAI text moderation (async, 50-200ms)
 * 3. If image: OpenAI image moderation (async, 500-1500ms)
 * 4. Take action based on highest-severity result
 *
 * Never throws — safe for fire-and-forget usage.
 */
export async function moderateMessage(
  messageId: string,
  content: string,
  type: string, // "text" | "image" | "video" etc.
  userId: string,
  chatGroupId: string,
  mediaUrl?: string | null
): Promise<void> {
  try {
    // 1. Keyword filter (sync)
    const keywordResult = checkKeywords(content)
    if (keywordResult && keywordResult.action === "hide") {
      await hideMessage(messageId, chatGroupId, userId, keywordResult)
      await flagForReview(messageId, chatGroupId, userId, keywordResult)
      await checkAndAutoMute(userId, chatGroupId)
      return
    }

    // 2. OpenAI text moderation (async)
    const textResult = await checkTextContent(content)
    if (textResult && textResult.action === "hide") {
      await hideMessage(messageId, chatGroupId, userId, textResult)
      await flagForReview(messageId, chatGroupId, userId, textResult)
      await checkAndAutoMute(userId, chatGroupId)
      return
    }

    // 3. Image moderation if applicable
    if ((type === "image" || type === "gif") && mediaUrl) {
      const imageResult = await checkImageContent(mediaUrl)
      if (imageResult && imageResult.action === "hide") {
        await hideMessage(messageId, chatGroupId, userId, imageResult)
        await flagForReview(messageId, chatGroupId, userId, imageResult)
        await checkAndAutoMute(userId, chatGroupId)
        return
      }
      // Flag image for review even at lower confidence
      if (imageResult && imageResult.action === "flag") {
        await flagForReview(messageId, chatGroupId, userId, imageResult)
        return
      }
    }

    // 4. Flag anything that was caught by keyword or text moderation at lower confidence
    const flagResult = keywordResult || textResult
    if (flagResult && flagResult.action === "flag") {
      await flagForReview(messageId, chatGroupId, userId, flagResult)
      return
    }

    // 5. Message is clean
    await markClean(messageId)
  } catch (error) {
    // Never let moderation errors propagate — log and move on
    logger.error("Moderation pipeline error", {
      messageId,
      error: String(error),
    })
  }
}

// Re-export spam check for sync use before message creation
export { checkSpam } from "./spam-detector"
