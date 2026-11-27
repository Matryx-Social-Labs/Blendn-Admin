import { logger } from "@/lib/logger"
import { checkKeywords } from "./keyword-filter"
import { checkTextContent, checkImageContent, type ModerationCheck } from "./openai-moderation"
import { hideMessage, flagForReview, checkAndAutoMute, recordExamined } from "./actions"
import { checkContactInfo } from "./contact-info"
import { forcedHide, textCheckFor } from "./staging-override"
import { readableUrl } from "@/lib/tigris"
import type { ModerationResult } from "./types"

/**
 * What is decided before the row is written.
 *
 * Both send routes ran `checkKeywords` themselves and hid on a match; contact
 * details ran later, inside `moderateMessage`, after the message had already
 * been emitted to the room. Now that a number in a room is removed rather than
 * flagged (see `contact-info.ts`), it has to be decided here, before the
 * emit — the ordering CLAUDE.md names as a real bug once already. One
 * function, so a third route cannot pick which checks to run before saving.
 *
 * `autoMute` is true for a slur only. Sharing your own number is not abuse
 * (SCRUM-485), and a swear word the list hides harms nobody else in the room
 * (D-052a): neither starts a mute, the count that decides the NEXT mute leaves
 * both out, and the auto-unmute counts the same way (`abuseHiddenCount` in
 * `actions.ts`). The model still judges such a line, after the response
 * (`recordHide`), and its `hide` counts.
 */
export function preSaveCheck(content: string): { hide: PreSaveHide | null; keyword: ModerationResult | null } {
  // The keyword verdict goes back too: a route reuses it for `inlineFlags` rather than asking twice.
  const keyword = checkKeywords(content)
  return { hide: hideBeforeSave(content, keyword), keyword }
}

type PreSaveHide = { result: ModerationResult; autoMute: boolean }

const keywordHide = (keyword: ModerationResult | null): PreSaveHide | null =>
  keyword?.action === "hide" ? { result: keyword, autoMute: "slur" in keyword.categories } : null

function hideBeforeSave(content: string, keyword: ModerationResult | null): PreSaveHide | null {
  const hide = keywordHide(keyword)
  if (hide) return hide
  const contact = checkContactInfo(content)
  if (contact && contact.action === "hide") return { result: contact, autoMute: false }
  return null
}

/**
 * Records a line the deterministic checks hid, off the response path: its flag,
 * then the mute count. A hide that does not count by itself (a swear word, a
 * contact detail) is put to the model, and the model's `hide` is recorded as
 * its own flag and counts. A model that cannot answer leaves the line uncounted.
 * The line is already hidden; nothing here is emitted. Never throws.
 */
export async function recordHide(
  messageId: string,
  chatGroupId: string,
  userId: string,
  content: string,
  hide: PreSaveHide,
  textCheck?: Promise<ModerationCheck>
): Promise<void> {
  try {
    // The flag before the count: the count reads flags (SCRUM-483).
    await flagForReview(messageId, chatGroupId, userId, hide.result)
    if (!hide.autoMute) {
      let text = await (textCheck ?? textCheckFor(userId, content))
      // A call that failed outright is asked once more, as `moderateMessage` does; a timeout or no key is not.
      if (!text.checked && text.reason === "error") text = await textCheckFor(userId, content)
      if (!text.checked) {
        logger.warn("Hidden line not judged by the model; it does not count toward a mute", { messageId, reason: text.reason })
        return
      }
      if (text.result?.action !== "hide") return
      await flagForReview(messageId, chatGroupId, userId, text.result)
    }
    await checkAndAutoMute(userId, chatGroupId)
  } catch (error) {
    logger.error("Failed to record a hidden line", { messageId, error: String(error) })
  }
}

/**
 * What a send route records for review when its inline check examined a line
 * and did not hide it: the model's flag and the keyword flag (`preSaveCheck`'s
 * `keyword`, reused), either or both. The line is still delivered.
 * `moderateMessage` records these itself when it runs instead.
 */
export function inlineFlags(...results: (ModerationResult | null)[]): ModerationResult[] {
  return results.filter((result): result is ModerationResult => result?.action === "flag")
}

/**
 * Main moderation orchestrator.
 * Started fire-and-forget by both room send routes for a message their 1 s text
 * check left unexamined: the route emits without waiting for it, and a hide here
 * removes the message from the room (`hideMessage`). An event room with more
 * than `BIG_ROOM_HERE_COUNT` people here waits for the verdict in
 * `verdictForBigRoom` instead, unless no API key is set.
 *
 * Pipeline:
 * 1. Keyword filter (sync, <1ms)
 * 2. OpenAI text moderation (async, 50-200ms)
 * 3. If image: OpenAI image moderation (async, 500-1500ms)
 * 4. Take action based on highest-severity result
 *
 * Never throws — safe for fire-and-forget usage.
 *
 * `textCheck` is the OpenAI text check a send route already started for this
 * message and gave up waiting for at its 1 s mark. Awaited here instead of
 * asking again: one call per message, and its verdict (a hide, say) lands as
 * soon as the first call answers rather than a full second round trip later.
 */
export async function moderateMessage(
  messageId: string,
  content: string,
  type: string, // "text" | "image" | "video" etc.
  userId: string,
  chatGroupId: string,
  mediaUrl?: string | null,
  textCheck?: Promise<ModerationCheck>
): Promise<void> {
  try {
    /*
     * 1. Contact details. Deterministic, sub-millisecond, and FIRST.
     *
     * This ran in `chat/groups/[chatGroupId]/messages` and not in
     * `events/[eventId]/chat`, so the event room -- the surface this product is
     * actually about -- never detected a phone number or a handle. Measured:
     * "add me on whatsapp 9876543210" posted to a live room raised no flag.
     *
     * It runs *before* the checks that can end the pipeline. A first attempt
     * placed it after them, so a message the model or the image check hid
     * returned early and its contact details went unrecorded -- the pattern
     * "this person keeps trying to move people off-platform" disappearing
     * exactly when they also did something worse. Two reasons on one message
     * should be two flags; losing one because the other fired first is not a
     * saving.
     *
     * **This does not cover keyword hides, and that is not fixed here.**
     * `events/[eventId]/chat` runs `checkKeywords` itself before saving, and on
     * a hide it writes the row, flags it and returns -- so `moderateMessage` is
     * never called and nothing below runs. Measured: "retard, telegram me
     * @sagar_k on 9812345678" produces one flag, for profanity, and no contact
     * flag. That is pre-existing route behaviour rather than a consequence of
     * this ordering, and closing it means either duplicating the check in the
     * route (the thing just deleted from the group route) or restructuring that
     * short-circuit. The message is hidden and the sender is a third of the way
     * to an auto-mute either way; what is lost is corroborating evidence.
     *
     * It flags and never hides. Taking a conversation off-platform is where
     * there is no block, no report and no record, so a moderator should see the
     * pattern -- but refusing the message would teach the sender the boundary
     * and cost the visibility, and the next attempt would be spelled out with
     * no flag behind it.
     */
    const contactResult = checkContactInfo(content)
    if (contactResult) {
      await flagForReview(messageId, chatGroupId, userId, contactResult)
    }

    // 2. Keyword filter (sync)
    // Staging's QA accounts, through the path a real verdict takes (lib/moderation/staging-override.ts).
    const forced = forcedHide(userId)
    if (forced?.checked && forced.result) {
      const result = { ...forced.result, source: mediaUrl ? ("openai_image" as const) : ("openai_text" as const) }
      await hideMessage(messageId, chatGroupId, userId, result)
      await flagForReview(messageId, chatGroupId, userId, result)
      await checkAndAutoMute(userId, chatGroupId)
      return
    }

    const keywordResult = checkKeywords(content)
    const hiddenByKeyword = keywordHide(keywordResult)
    if (hiddenByKeyword) {
      await hideMessage(messageId, chatGroupId, userId, hiddenByKeyword.result)
      await recordHide(messageId, chatGroupId, userId, content, hiddenByKeyword, textCheck)
      return
    }

    // 3. OpenAI text moderation (async)
    let text = await (textCheck ?? checkTextContent(content))
    /*
     * The in-flight check is reused so a message costs one call, but a call that
     * FAILED outright (a 429, a 5xx, a reset) is not an answer: this pipeline
     * always asked again, and a line that went out unchecked must not stay
     * visible for want of a second look. A timeout is not retried (another 8 s
     * wait on the same stalled API) and neither is a missing key.
     */
    if (textCheck && !text.checked && text.reason === "error") text = await checkTextContent(content)
    const textResult = text.checked ? text.result : null
    if (textResult && textResult.action === "hide") {
      await hideMessage(messageId, chatGroupId, userId, textResult)
      await flagForReview(messageId, chatGroupId, userId, textResult)
      await checkAndAutoMute(userId, chatGroupId)
      return
    }

    /*
     * 4. The media, whatever `type` says (SCRUM-444).
     *
     * This looked only when `type` was "image" or "gif", and the type is the
     * client's word: `type: "text"` with a `metadata.mediaUrl` stored an image
     * nobody screened, and `type: "video"` over a JPEG was recorded clean. A
     * file the check can't read (a clip, a voice note) comes back unchecked,
     * which is what it is.
     */
    let imageExamined = true
    if (mediaUrl) {
      // The vendor fetches the image: a private one needs a signed URL, or it scores a 403 (SCRUM-427).
      const imageCheck = await checkImageContent(await readableUrl(mediaUrl))
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
    await recordExamined(messageId, text.checked && imageExamined)
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
