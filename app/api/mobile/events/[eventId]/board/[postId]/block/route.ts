import { NextRequest } from "next/server"

import { isUuid } from "@/lib/api-input"
import {
  errorResponse,
  notFoundResponse,
  serverErrorResponse,
  unauthorizedResponse,
} from "@/lib/api-response"
import { boardPostAuthorFor } from "@/lib/board-access"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { POST as blockUser } from "@/app/api/mobile/users/[userId]/block/route"

interface RouteParams {
  params: Promise<{ eventId: string; postId: string }>
}

/**
 * Block a board post's author, by the post (SCRUM-322).
 *
 * The board never hands the client a user id, so the client cannot call
 * `POST /users/:userId/block`. This resolves the author and then IS that
 * route — the same transaction (block row, message requests cancelled both
 * ways, friendship severed, conversation closed and its socket room evicted)
 * and the same response — rather than a second copy of it to drift.
 *
 * Board asks between the two are left as they are, deliberately: an ask from
 * the blocked person drops out of the blocker's list and cannot be accepted,
 * and to its asker it reads as an ask on a withdrawn post — the same as if the
 * post had been taken down, which is all a block should tell them.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return unauthorizedResponse("Authentication required")

    const limited = await rateLimit(request, userLimit("safety", "block-board", user.userId))
    if (limited) return limited

    const { eventId, postId } = await params
    if (!isUuid(eventId)) return errorResponse("Invalid event ID format", 400)
    if (!isUuid(postId)) return errorResponse("Invalid post ID format", 400)

    const authorId = await boardPostAuthorFor(user.userId, eventId, postId)
    if (!authorId) return notFoundResponse("Post not found")
    if (authorId === user.userId) return errorResponse("Cannot block yourself", 400)

    return blockUser(request, { params: Promise.resolve({ userId: authorId }) })
  } catch (error) {
    logger.error("Board post block error", {
      error: error instanceof Error ? error.message : String(error),
    })
    return serverErrorResponse("Failed to block user")
  }
}
