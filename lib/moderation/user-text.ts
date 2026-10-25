import { NextResponse } from "next/server"
import { auditLog } from "../audit-log"
import { logger } from "../logger"
import { ErrorCode } from "../api-response"
import { checkKeywords } from "./keyword-filter"
import { checkLinkSpam } from "./spam-detector"
import type { ModerationResult } from "./types"

/**
 * Text a person writes once and strangers read: a display name, a bio, the
 * occupation and education beside it, and the first message of a message
 * request (App Store 1.2). Crews run the same record through `crewTextRefusal`.
 *
 * Screened on write, synchronously, with the deterministic checks only: the
 * keyword filter's hides and the spam detector's link density. No model is
 * called on a save path. A hit is refused, never stored, so nothing needs
 * hiding later. A keyword *flag* (a suspicion found only after stripping
 * separators, "the flag") is let through, as it is in a room.
 *
 * The refusal is recorded as an audit row (`moderation.text_refused`), not a
 * `moderation_flags` row: a flag is a chat message's (`message_id` is a NOT
 * NULL foreign key to `chat_messages`), and refused text has no message.
 */

/** The `reasonCode` on a refusal. `errorCode` stays `VALIDATION_FAILED`. */
export const TEXT_NOT_ALLOWED = "TEXT_NOT_ALLOWED"

export type TextSurface = "profile" | "crew" | "message_request"

/** Why this text may not be saved, or null. Deterministic and sub-millisecond. */
export function objectionableText(text: string): ModerationResult | null {
  const keyword = checkKeywords(text)
  if (keyword?.action === "hide") return keyword
  return checkLinkSpam(text)
}

/** Log and audit a refused text. The words that matched go in the row; the text itself does not. */
export function recordRefusedText(userId: string | null, surface: TextSurface, field: string, result: ModerationResult): void {
  const details = {
    surface,
    field,
    source: result.source,
    ...(result.matched && { matched: result.matched }),
    ...(result.reason && { reason: result.reason }),
  }
  logger.info("User text refused", { userId, ...details })
  auditLog({
    ...(userId && { userId, resourceId: userId }),
    action: "moderation.text_refused",
    resource: "user",
    details,
  })
}

/**
 * The first of these fields that may not be saved, recorded, or null. Empty
 * and absent fields are skipped (clearing a bio is always allowed).
 */
export function screenUserText(
  userId: string | null,
  surface: TextSurface,
  fields: Record<string, string | null | undefined>
): { field: string } | null {
  for (const [field, text] of Object.entries(fields)) {
    if (!text) continue
    const result = objectionableText(text)
    if (!result) continue
    recordRefusedText(userId, surface, field, result)
    return { field }
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
