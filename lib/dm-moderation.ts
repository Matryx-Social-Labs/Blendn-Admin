// Relative imports — see lib/conversations.ts. Enforced by
// __tests__/server-import-boundary.test.ts.
import { checkContactInfo } from "./moderation/contact-info"
import { checkKeywords } from "./moderation/keyword-filter"
import { checkSpam } from "./moderation/spam-detector"

/**
 * Screening a direct message. The deterministic checks, and only those.
 *
 * ## Why DMs had none at all
 *
 * `lib/moderation` is imported by exactly two files and both are group chat.
 * A DM received no keyword check, no spam check and no contact-info check —
 * and `contact-info.ts`'s own docstring names the DM as where the harm it
 * targets lands. It is the one channel in this product nobody was watching,
 * and it is the one where somebody is alone with a stranger.
 *
 * ## Why no model, and why that is a decision rather than a gap
 *
 * `TR5`. A model check means an unreviewed private message is sent to a third
 * party and, on a hit, becomes something a human may read. Deterministic checks
 * need no external service, cannot fail open, and answer the questions actually
 * worth asking here — is this a flood, is this a slur, is this someone moving
 * the conversation somewhere with no block and no record.
 *
 * Nothing here is read by a human unless the recipient reports it.
 *
 * ## Contact details are flagged, never refused
 *
 * The same rule the group path settled on, for the same reason: refusing
 * teaches the sender exactly where the boundary is, and the next attempt is
 * spelled out with nothing behind it. Recording it keeps the pattern visible to
 * whoever eventually reads a report.
 */
export type DirectMessageScreen =
  /** Send it. `status` is recorded on the row when something was noticed. */
  | { verdict: "allow"; status: string | null }
  /** Refuse, and say why — a flood is worth telling somebody about. */
  | { verdict: "refuse"; reason: string; code: "spam" }
  /**
   * Store it hidden and tell the sender it was hidden.
   *
   * Not a silent drop: a sender who thinks a message arrived and gets no reply
   * concludes they were ignored, which is worse than being told. Not a refusal
   * either, because the row is the only evidence a later report can rest on.
   */
  | { verdict: "hide"; status: "hidden" }

export async function screenDirectMessage(input: {
  senderId: string
  conversationId: string
  text: string | null | undefined
}): Promise<DirectMessageScreen> {
  const text = input.text?.trim()
  // A photo with no caption has nothing deterministic to check. Media
  // moderation is the model's job and the model does not run here.
  if (!text) return { verdict: "allow", status: null }

  /*
   * Spam first, and it refuses rather than hides.
   *
   * A flood is the one failure the recipient feels immediately — every message
   * is a push — so it is stopped at the door. The scope key is the
   * conversation, so somebody messaging ten different people is not throttled
   * as though they were flooding one.
   */
  const spam = await checkSpam(input.senderId, input.conversationId, text)
  if (spam?.action === "hide") {
    return {
      verdict: "refuse",
      reason: spam.reason || "You are sending messages too quickly.",
      code: "spam",
    }
  }

  const keyword = checkKeywords(text)
  if (keyword?.action === "hide") return { verdict: "hide", status: "hidden" }

  /*
   * Contact details, and the ordering matters: this runs even when the keyword
   * check merely flagged, so two reasons on one message stay two reasons. The
   * group pipeline lost one of them for exactly this reason and it is recorded
   * there as a defect.
   */
  if (checkContactInfo(text)) return { verdict: "allow", status: "flagged" }
  if (keyword) return { verdict: "allow", status: "flagged" }

  /*
   * NULL, not "clean". No model ran, so there is no clean bill to record —
   * writing one would be G3 in a new table.
   */
  return { verdict: "allow", status: null }
}

/**
 * The predicate every read of `private_messages` must carry.
 *
 * One constant rather than three inline clauses, because "is this message
 * visible" is one question and this codebase's dominant defect is one question
 * with several answers. Three readers need it — the thread, the inbox's
 * last-message preview, and the unread count — and the third is the one that
 * gets forgotten: a hidden message is never marked read, so leaving it in the
 * count leaves a badge nobody can clear on a thread with nothing in it.
 *
 * **Written as an explicit OR rather than `{ not: "hidden" }`.** In SQL,
 * `moderation_status <> 'hidden'` is NULL for a NULL row and therefore false,
 * and NULL is the ordinary case here — almost every message has no verdict. A
 * `not` that Prisma did not expand to include NULL would hide the entire
 * message history of every conversation in the product. That is not a risk
 * worth taking on a translation detail, and `geofence-clear.itest.ts` is the
 * precedent: a nullability distinction that read correctly through the client
 * and was false in the database.
 */
export const VISIBLE_DM: {
  OR: { moderation_status: null | { not: string } }[]
} = {
  OR: [{ moderation_status: null }, { moderation_status: { not: "hidden" } }],
}
