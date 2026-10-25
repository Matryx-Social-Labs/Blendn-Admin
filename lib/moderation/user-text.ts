import { NextResponse } from "next/server"
import { auditLog } from "../audit-log"
import { logger } from "../logger"
import { ErrorCode } from "../api-response"
import { checkIdentityKeywords, checkKeywords } from "./keyword-filter"
import { checkLinkSpam } from "./spam-detector"
import type { ModerationResult } from "./types"

/**
 * Text a person writes once and strangers read (App Store 1.2), screened on
 * write, synchronously, with the deterministic checks only. No model is called
 * on a save path. Two kinds, two lists:
 *
 * - **Identity text** — a display name, bio, occupation, education, location,
 *   a crew's name and bio — is refused only for an unambiguous slur
 *   (`checkIdentityKeywords`). A word that is also a name, an ordinary word, a
 *   place or a faith ("Magi", "Bal Krishna", "Sunni Muslim") is let through and
 *   flagged for a human, never refused: refusing it blocks a real person from
 *   signing up (PR #755 review, H1).
 * - **A message** — a message request's first line — is held to the chat rule,
 *   as it would be in a room: a whole-word hit on the chat list is refused.
 *
 * Both refuse link spam (the spam detector's link density). A refusal is an
 * audit row (`moderation.text_refused`) and a flag one (`moderation.text_flagged`),
 * not `moderation_flags` rows: a flag there is a chat message's (`message_id`
 * is a NOT NULL foreign key to `chat_messages`), and this text has no message.
 */

/** The `reasonCode` on a refusal. `errorCode` stays `VALIDATION_FAILED`. */
export const TEXT_NOT_ALLOWED = "TEXT_NOT_ALLOWED"

export type TextSurface = "profile" | "crew" | "message_request" | "oauth_name"

/** What the screen decided about one text: refuse it, let it through flagged for review, or nothing to say. */
export type TextVerdict = { action: "refuse" | "flag"; result: ModerationResult } | null

/** The chat rule, for a message: a whole-word hit on the chat list, or link spam. */
export function objectionableText(text: string): ModerationResult | null {
  const keyword = checkKeywords(text)
  if (keyword?.action === "hide") return keyword
  return checkLinkSpam(text)
}

/** The chat rule as a verdict: a message is refused or left alone, never flagged here. */
function messageTextVerdict(text: string): TextVerdict {
  const result = objectionableText(text)
  return result ? { action: "refuse", result } : null
}

/** The identity rule, for a name or a card: refused only for an unambiguous slur or link spam; any other keyword hit is flagged. */
export function identityTextVerdict(text: string): TextVerdict {
  const keyword = checkIdentityKeywords(text)
  if (keyword?.action === "hide") return { action: "refuse", result: keyword }
  const links = checkLinkSpam(text)
  if (links) return { action: "refuse", result: links }
  return keyword ? { action: "flag", result: keyword } : null
}

/** Log and audit a refused or flagged text. The words that matched go in the row; the text itself does not. */
export function recordScreenedText(
  userId: string | null,
  surface: TextSurface,
  field: string,
  verdict: NonNullable<TextVerdict>
): void {
  const { result } = verdict
  const details = {
    surface,
    field,
    source: result.source,
    ...(result.matched && { matched: result.matched }),
    ...(result.reason && { reason: result.reason }),
  }
  logger.info(verdict.action === "refuse" ? "User text refused" : "User text flagged for review", { userId, ...details })
  auditLog({
    ...(userId && { userId, resourceId: userId }),
    action: verdict.action === "refuse" ? "moderation.text_refused" : "moderation.text_flagged",
    resource: "user",
    details,
  })
}

/**
 * The first of these fields that may not be saved, recorded, or null. Flagged
 * fields are recorded and let through. Empty and absent fields are skipped
 * (clearing a bio is always allowed). `message_request` is a message; every
 * other surface is identity text.
 */
export function screenUserText(
  userId: string | null,
  surface: TextSurface,
  fields: Record<string, string | null | undefined>
): { field: string } | null {
  for (const [field, text] of Object.entries(fields)) {
    if (!text) continue
    const verdict = surface === "message_request" ? messageTextVerdict(text) : identityTextVerdict(text)
    if (!verdict) continue
    recordScreenedText(userId, surface, field, verdict)
    if (verdict.action === "refuse") return { field }
  }
  return null
}

/** 400 `VALIDATION_FAILED` / `TEXT_NOT_ALLOWED`, naming the field as every validation answer does. */
export function textNotAllowedResponse(field: string, message: string): NextResponse {
  return NextResponse.json(
    {
      success: false,
      error: message,
      errorCode: ErrorCode.VALIDATION_FAILED,
      reasonCode: TEXT_NOT_ALLOWED,
      field,
      errors: [{ field, message }],
    },
    { status: 400 }
  )
}
