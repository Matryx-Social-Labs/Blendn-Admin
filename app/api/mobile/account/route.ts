import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { successResponse, unauthorizedResponse, serverErrorResponse } from "@/lib/api-response"

// DELETE /api/mobile/account — Delete the authenticated user's own account.
//
// We anonymize rather than hard-delete the User row: organized_events,
// chat_messages, and several other relations cascade-delete on User
// removal, which would destroy other users' event history and chat
// history just because one attendee deleted their account. Instead we
// scrub PII, revoke all auth (refresh tokens, push tokens, OAuth links,
// any dashboard sessions), and mark deletedAt so the account can never
// be signed back into.
export async function DELETE(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Authentication required")
    }

    const anonymizedEmail = `deleted-${authUser.userId}@deleted.blendn.invalid`

    await db.$transaction([
      db.user.update({
        where: { id: authUser.userId },
        data: {
          name: null,
          email: anonymizedEmail,
          emailVerified: null,
          password: null,
          image: null,
          deletedAt: new Date(),
        },
      }),
      db.profiles.update({
        where: { id: authUser.userId },
        data: {
          name: null,
          phone: null,
          age: null,
          location: null,
          bio: null,
          occupation: null,
          education: null,
          interests: [],
          photos: [],
          onboarded: false,
        },
      }),
      db.mobile_refresh_tokens.deleteMany({ where: { user_id: authUser.userId } }),
      db.push_tokens.deleteMany({ where: { user_id: authUser.userId } }),
      db.user_oauth_accounts.deleteMany({ where: { user_id: authUser.userId } }),
      db.account.deleteMany({ where: { userId: authUser.userId } }),
      db.session.deleteMany({ where: { userId: authUser.userId } }),
    ])

    return successResponse({ deleted: true })
  } catch (error) {
    logger.error("Account deletion error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to delete account")
  }
}
