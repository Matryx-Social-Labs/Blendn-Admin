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
import { boardRequestCounterpart } from "@/lib/board-access"
import { db } from "@/lib/db"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"

interface RouteParams {
  params: Promise<{ requestId: string }>
}

/**
 * Report a board ask (SCRUM-322) — by either of its two people, about the
 * other. Usually the person asked, about the ask's message.
 *
 * Filed into `message_reports` as `message_type: "board_request"`. The queue
 * names whoever of the two did not file it.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return unauthorizedResponse("Authentication required")

    const limited = await rateLimit(request, userLimit("safety", "report-board", user.userId))
    if (limited) return limited

    const { requestId } = await params
    if (!isUuid(requestId)) return errorResponse("Invalid request ID format", 400)

    const validation = boardReportSchema.safeParse(await readJson(request))
    if (!validation.success) return validationErrorResponse(validation.error)
    const input = validation.data

    if (!(await boardRequestCounterpart(user.userId, requestId))) {
      return notFoundResponse("Request not found")
    }

    await db.message_reports.create({
      data: {
        reporter_id: user.userId,
        message_id: requestId,
        message_type: "board_request",
        reason: input.reason,
        ...(input.description && { description: input.description }),
      },
    })
    return successResponse({ reported: true }, 201)
  } catch (error) {
    logger.error("Board request report error", {
      error: error instanceof Error ? error.message : String(error),
    })
    return serverErrorResponse("Failed to submit report")
  }
}
