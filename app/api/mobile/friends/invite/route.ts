import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { inviteTokenFor, inviteUrl, resetInviteToken } from "@/lib/friends"
import { successResponse, unauthorizedResponse, serverErrorResponse } from "@/lib/api-response"

/**
 * GET /api/mobile/friends/invite — the caller's invite link, made on first ask.
 *
 * The link is the only way anyone reaches this person without already knowing
 * them, so it is theirs to hand out and theirs to kill (POST resets it).
 */
export async function GET(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const token = await inviteTokenFor(authUser.userId)
    return successResponse({ token, url: inviteUrl(token) })
  } catch (error) {
    logger.error("Get invite link error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to load invite link")
  }
}

/**
 * POST /api/mobile/friends/invite — a new link. The old one then answers
 * exactly as a link that never existed. Friends already made stay friends.
 */
export async function POST(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")

    const limited = await rateLimit(request, userLimit("heavy", "friend-invite-reset", authUser.userId))
    if (limited) return limited

    const token = await resetInviteToken(authUser.userId)
    return successResponse({ token, url: inviteUrl(token) })
  } catch (error) {
    logger.error("Reset invite link error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to reset invite link")
  }
}
