import { logger } from "@/lib/logger"
import { deletionReauthRefusal } from "@/lib/deletion-reauth"
import { NextRequest, after } from "next/server"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { eraseAccount } from "@/lib/account-erasure"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { successResponse, unauthorizedResponse, serverErrorResponse, validationErrorResponse } from "@/lib/api-response"
import { readOptionalJson } from "@/lib/api-input"
import { getRequestIp } from "@/lib/audit-log"
import { z } from "zod"

/**
 * The delete's optional body. `appleAuthorizationCode`: a fresh code from Sign
 * in with Apple, sent by the app when the account is Apple-linked, so the grant
 * can be revoked (5.1.1(v)). Apple's codes are short; the cap only bounds input.
 *
 * Strict: the default action here is erasure, so a body this route cannot read
 * (unknown keys, wrong types, not JSON) is a 400 and erases nothing. No body,
 * or `{}`, deletes as it always did.
 */
const deleteAccountSchema = z
  .object({
    appleAuthorizationCode: z.string().trim().min(1).max(2048).optional(),
    // Who is deleting (SCRUM-944 (3), lib/deletion-reauth.ts): one of these.
    password: z.string().min(1).max(200).optional(),
    googleIdToken: z.string().min(1).max(4096).optional(),
    appleIdentityToken: z.string().min(1).max(4096).optional(),
  })
  .strict()

// DELETE /api/mobile/account — Delete the authenticated user's own account.
// The erasure itself is `eraseAccount` (lib/account-erasure.ts).
export async function DELETE(request: NextRequest) {
  // Declared outside the try so the failure log can name the account -- a
  // rolled-back erasure of ~20 tables was logged without saying whose.
  let authUser: Awaited<ReturnType<typeof getAuthenticatedUser>> = null
  try {
    authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Authentication required")
    }

    const limited = await rateLimit(request, userLimit("heavy", "account-delete", authUser.userId))
    if (limited) return limited

    const parsed = deleteAccountSchema.safeParse(await readOptionalJson(request))
    if (!parsed.success) return validationErrorResponse(parsed.error)
    const refused = await deletionReauthRefusal(authUser.userId, parsed.data, getRequestIp(request))
    if (refused) return refused
    await eraseAccount(authUser.userId, {
      ipAddress: getRequestIp(request),
      appleAuthorizationCode: parsed.data.appleAuthorizationCode,
      defer: after,
    })

    return successResponse({ deleted: true })
  } catch (error) {
    logger.error("Account deletion error", { userId: authUser?.userId, error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to delete account")
  }
}
