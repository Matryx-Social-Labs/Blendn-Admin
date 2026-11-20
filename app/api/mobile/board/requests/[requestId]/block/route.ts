import { NextRequest } from "next/server"

import { isUuid } from "@/lib/api-input"
import {
  errorResponse,
  notFoundResponse,
  serverErrorResponse,
  unauthorizedResponse,
} from "@/lib/api-response"
import { boardRequestCounterpart } from "@/lib/board-access"
import { roomHandle } from "@/lib/room-handle"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { POST as blockUser } from "@/app/api/mobile/users/[userId]/block/route"

interface RouteParams {
  params: Promise<{ requestId: string }>
}

/**
 * Block the other person on a board ask, by the ask (SCRUM-322). Resolves who,
 * then is `POST /users/:userId/block` — see the post's block route for why.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return unauthorizedResponse("Authentication required")

    const limited = await rateLimit(request, userLimit("safety", "block-board", user.userId))
    if (limited) return limited

    const { requestId } = await params
    if (!isUuid(requestId)) return errorResponse("Invalid request ID format", 400)

    const other = await boardRequestCounterpart(user.userId, requestId)
    if (!other) return notFoundResponse("Request not found")

    // By the event's handle, as the post's block does: the block keeps the board's pseudonym and the event.
    return blockUser(request, { params: Promise.resolve({ userId: roomHandle(other.eventId, other.userId) }) })
  } catch (error) {
    logger.error("Board request block error", {
      error: error instanceof Error ? error.message : String(error),
    })
    return serverErrorResponse("Failed to block user")
  }
}
