import { ErrorCode, errorResponse } from "@/lib/api-response"
import { STAFF_MESSAGE, SUSPENDED_MESSAGE } from "@/lib/mobile-auth"

/**
 * The 403 an account that may not hold a session gets, at every entry point
 * (sign-in, Google, Apple, refresh, session). The sentence is the one installed
 * builds match on; the code is what a client that knows it reads first.
 */
export function accountRefusal(reason: "suspended" | "staff") {
  return reason === "suspended"
    ? errorResponse(SUSPENDED_MESSAGE, 403, ErrorCode.ACCOUNT_SUSPENDED)
    : errorResponse(STAFF_MESSAGE, 403, ErrorCode.ACCOUNT_STAFF)
}
