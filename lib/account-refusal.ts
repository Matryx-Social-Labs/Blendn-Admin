import { ErrorCode, errorResponse } from "@/lib/api-response"
import { STAFF_MESSAGE, SUSPENDED_MESSAGE } from "@/lib/mobile-auth"

/**
 * The 403 an account that may not hold a session gets, at every entry point
 * (sign-in, Google, Apple, refresh, session). `errorCode` stays `FORBIDDEN` and
 * the sentence stays word for word: installed builds show the sentence on
 * exactly that pair. The reason is `reasonCode`.
 */
export function accountRefusal(reason: "suspended" | "staff") {
  return reason === "suspended"
    ? errorResponse(SUSPENDED_MESSAGE, 403, ErrorCode.FORBIDDEN, ErrorCode.ACCOUNT_SUSPENDED)
    : errorResponse(STAFF_MESSAGE, 403, ErrorCode.FORBIDDEN, ErrorCode.ACCOUNT_STAFF)
}
