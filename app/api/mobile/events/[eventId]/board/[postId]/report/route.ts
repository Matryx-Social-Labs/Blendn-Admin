import { NextRequest } from "next/server"

import { readJson, isUuid } from "@/lib/api-input"
import {
  errorResponse,
  notFoundResponse,
  serverErrorResponse,
  successResponse,
  unauthorizedResponse,
  validationErrorResponse,
} from "@/lib/api-response"
import { boardReportSchema } from "@/lib/board"
import { boardPostAuthorFor } from "@/lib/board-access"
import { db } from "@/lib/db"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"

interface RouteParams {
  params: Promise<{ eventId: string; postId: string }>
}

/**
 * Report a board post (SCRUM-322).
 *
 * Filed into `message_reports` as `message_type: "board_post"`, so it reaches
 * the admin queue beside room messages and DMs — that table's `message_id`
 * carries no foreign key precisely because it points at more than one table.
 * The author is resolved here and never returned.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return unauthorizedResponse("Authentication required")

    const limited = await rateLimit(request, userLimit("safety", "report-board", user.userId))
    if (limited) return limited

    const { eventId, postId } = await params
    if (!isUuid(eventId)) return errorResponse("Invalid event ID format", 400)
    if (!isUuid(postId)) return errorResponse("Invalid post ID format", 400)

    const validation = boardReportSchema.safeParse(await readJson(request))
    if (!validation.success) return validationErrorResponse(validation.error)
    const input = validation.data

    const authorId = await boardPostAuthorFor(user.userId, eventId, postId)
    if (!authorId) return notFoundResponse("Post not found")
    if (authorId === user.userId) return errorResponse("Cannot report your own post", 400)

    await db.message_reports.create({
      data: {
        reporter_id: user.userId,
        message_id: postId,
        message_type: "board_post",
        reason: input.reason,
        ...(input.description && { description: input.description }),
      },
    })
    return successResponse({ reported: true }, 201)
  } catch (error) {
    logger.error("Board post report error", {
      error: error instanceof Error ? error.message : String(error),
    })
    return serverErrorResponse("Failed to submit report")
  }
}
