import { ErrorCode, errorResponse } from "@/lib/api-response"
import { COMPANY } from "@/lib/company"
import { STAFF_MESSAGE, SUSPENDED_MESSAGE } from "@/lib/mobile-auth"
import { SUSPENSION_CATEGORIES, suspensionCategory } from "@/lib/suspension"

/**
 * What the owner of a suspended account reads: the category and where to appeal.
 * It starts with the generic sentence's first one, which installed builds show
 * as the title and classify on; the rest is the body. Free text in
 * `suspension_reason` is never echoed: it reads as community guidelines.
 */
export function suspendedMessageFor(suspensionReason: string | null): string {
  const reason = SUSPENSION_CATEGORIES[suspensionCategory(suspensionReason)]
  return `This account has been suspended. Reason: ${reason}. To appeal, write to ${COMPANY.grievance.email}.`
}

/**
 * The 403 an account that may not hold a session gets, at every entry point
 * (sign-in, Google, Apple, refresh, session). `errorCode` stays `FORBIDDEN` and
 * the reason is `reasonCode`: installed builds show the sentence on that pair.
 *
 * `owner` is the suspended account itself, passed only where the caller has
 * proven they are it (after the password, a verified provider token, that
 * account's refresh token, an authenticated request). Without it the sentence
 * is the generic one, so no refusal tells anyone else why an account was
 * suspended.
 */
export function accountRefusal(reason: "suspended" | "staff", owner?: { suspension_reason: string | null } | null) {
  if (reason === "staff") return errorResponse(STAFF_MESSAGE, 403, ErrorCode.FORBIDDEN, ErrorCode.ACCOUNT_STAFF)
  const message = owner ? suspendedMessageFor(owner.suspension_reason) : SUSPENDED_MESSAGE
  return errorResponse(message, 403, ErrorCode.FORBIDDEN, ErrorCode.ACCOUNT_SUSPENDED)
}
