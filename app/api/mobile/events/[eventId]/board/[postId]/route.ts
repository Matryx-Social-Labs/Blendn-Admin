import { NextRequest } from "next/server"

import {
  notFoundResponse,
  serverErrorResponse,
  successResponse,
  unauthorizedResponse,
} from "@/lib/api-response"
import { db } from "@/lib/db"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"

interface RouteParams {
  params: Promise<{ eventId: string; postId: string }>
}

/**
 * The author takes their post back (SCRUM-301).
 *
 * Soft: `deleted_at`, which every board read already filters, and which
 * `liveRequest()` reads so the requests people filed against it stop counting
 * toward their limits. Somebody else's post, or one already gone, is a 404 —
 * not a 403 that would confirm it exists.
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return unauthorizedResponse("Authentication required")

    const limited = await rateLimit(request, userLimit("write", "board-withdraw", user.userId))
    if (limited) return limited

    const { eventId, postId } = await params
    const now = new Date()
    const { count } = await db.board_posts.updateMany({
      where: { id: postId, event_id: eventId, author_id: user.userId, deleted_at: null },
      data: { deleted_at: now, updated_at: now },
    })
    if (count === 0) return notFoundResponse("Post not found")

    return successResponse({ id: postId, withdrawn: true })
  } catch (error) {
    logger.error("Board withdraw error", {
      error: error instanceof Error ? error.message : String(error),
    })
    return serverErrorResponse("Failed to withdraw")
  }
}
