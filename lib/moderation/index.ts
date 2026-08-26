import { logger } from "@/lib/logger"
import { checkKeywords } from "./keyword-filter"
import { checkTextContent, checkImageContent } from "./openai-moderation"
import { hideMessage, flagForReview, checkAndAutoMute, recordExamined } from "./actions"
import { checkContactInfo } from "./contact-info"

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
    const textCheck = await checkTextContent(content)
    const textResult = textCheck.checked ? textCheck.result : null
    if (textResult && textResult.action === "hide") {
      await hideMessage(messageId, chatGroupId, userId, textResult)
      await flagForReview(messageId, chatGroupId, userId, textResult)
      await checkAndAutoMute(userId, chatGroupId)
      return
    }

    // 3. Image moderation if applicable
    let imageExamined = true
    if ((type === "image" || type === "gif") && mediaUrl) {
      const imageCheck = await checkImageContent(mediaUrl)
      imageExamined = imageCheck.checked
      const imageResult = imageCheck.checked ? imageCheck.result : null
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

    /*
     * 4. Contact details, in the pipeline rather than in a route.
     *
     * This ran in `chat/groups/[chatGroupId]/messages` and **not** in
     * `events/[eventId]/chat`, so the event room — the surface this product is
     * actually about — never detected a phone number or a handle. Measured:
     * posting "add me on whatsapp 9876543210" to a live event room raised no
     * flag at all.
     *
     * `contact-info.ts`'s own docstring says it runs "server-side before
     * persist", which was true of one of the two write paths. Moving it here
     * makes it true of both, and of the third one somebody adds — the same
     * argument as every resolver in this codebase: the mechanism was right and
     * using it was optional.
     *
     * It flags and never hides. Taking a conversation off-platform is where
     * there is no block, no report and no record, so a moderator should see the
     * pattern — but refusing the message would teach the sender the boundary
     * and cost the visibility, and the next attempt would be spelled out with
     * no flag behind it.
     */
    const contactResult = checkContactInfo(content)
    if (contactResult) {
      await flagForReview(messageId, chatGroupId, userId, contactResult)
    }

    // 5. Flag anything caught by keyword or text moderation at lower confidence
    const flagResult = keywordResult || textResult
    if (flagResult && flagResult.action === "flag") {
      await flagForReview(messageId, chatGroupId, userId, flagResult)
      return
    }

    /*
     * A contact-info flag ends the pipeline here, for the same reason the two
     * branches above return: `recordExamined` writes `moderation_status`
     * unconditionally, so falling through would overwrite `flagged` with
     * `unchecked` and leave the message contradicting its own flag row.
     *
     * Found by running it rather than reading it — the flag was created
     * correctly and the status said `unchecked`, which is precisely the
     * two-vocabularies-for-one-word problem this schema already has once.
     *
     * It is checked separately from `flagResult` rather than folded into it so
     * that a message carrying *both* contact details and a low-confidence
     * keyword hit raises both flags. They are different categories and a
     * moderator wants both.
     */
    if (contactResult) return

    /*
     * 6. Nothing was caught. Whether that means "clean" depends on whether
     *    anybody actually looked.
     *
     * This wrote `clean` unconditionally, so with `OPENAI_API_KEY` unset -- the
     * ordinary deployment, since `lib/env.ts` marks it optional and
     * `DEPLOYMENT.md` lists it as not required -- every message in the database
     * was recorded as examined and clean by a moderator that was never called.
     * The keyword filter's 130 hard-coded strings were the whole pipeline, and
     * nothing said so.
     */
    await recordExamined(messageId, textCheck.checked && imageExamined)
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
