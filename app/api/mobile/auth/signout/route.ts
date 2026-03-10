import { NextRequest } from "next/server"
import {
  getAuthenticatedUser,
  revokeUserRefreshTokens,
  revokeRefreshToken,
} from "@/lib/mobile-auth"
import { auditLog, getRequestIp } from "@/lib/audit-log"
import {
  successResponse,
  unauthorizedResponse,
  serverErrorResponse,
} from "@/lib/api-response"

export async function POST(request: NextRequest) {
  try {
    // Get authenticated user
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    // Try to get refresh token from body to revoke specific token
    let revokedAll = false
    try {
      const body = await request.json()
      if (body.refreshToken) {
        await revokeRefreshToken(body.refreshToken)
      } else {
        // Revoke all refresh tokens for user
        await revokeUserRefreshTokens(authUser.userId)
        revokedAll = true
      }
    } catch {
      // No body or invalid JSON, revoke all tokens
      await revokeUserRefreshTokens(authUser.userId)
      revokedAll = true
    }

    auditLog({
      userId: authUser.userId,
      action: revokedAll ? "signout_all" : "signout",
      resource: "auth",
      ipAddress: getRequestIp(request),
    })

    return successResponse({
      message: revokedAll
        ? "Signed out from all devices"
        : "Signed out successfully",
    })
  } catch (error) {
    console.error("Signout error:", error)
    return serverErrorResponse("Failed to sign out")
  }
}
