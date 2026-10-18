import { NextRequest } from "next/server"

import { readJson } from "@/lib/api-input"
import {
  errorResponse,
  notFoundResponse,
  serverErrorResponse,
  successResponse,
  unauthorizedResponse,
  validationErrorResponse,
} from "@/lib/api-response"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { reportRoomMember, reportRoomMemberSchema } from "@/lib/room-member-report"

interface RouteParams {
  params: Promise<{ chatGroupId: string; userId: string }>
}

/**
 * POST /api/mobile/chat/groups/:chatGroupId/members/:userId/report — report a
 * person in a crew's or a Blend's room, `userId` being the handle that room
 * showed you (`{ reason, description? }`). Members of that room only; every
 * other caller, a room of another kind, a handle from another room or a forged
 * one gets the one 404 ("Chat group not found"). 201 `{ reported: true }`.
 * Reaches the same admin queue as `POST /users/:id/report`. Capped per minute
 * and per day, as every report is.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Authentication required")
    const limited =
      (await rateLimit(request, userLimit("safety", "report-room-member", authUser.userId))) ??
      (await rateLimit(request, userLimit("reportDay", "report-room-member-day", authUser.userId)))
    if (limited) return limited

    const parsed = reportRoomMemberSchema.safeParse(await readJson(request))
    if (!parsed.success) return validationErrorResponse(parsed.error)

    const { chatGroupId, userId } = await params
    const outcome = await reportRoomMember(authUser.userId, chatGroupId, userId, parsed.data)
    if (outcome === "not_found") return notFoundResponse("Chat group not found")
    if (outcome === "self") return errorResponse("Cannot report yourself", 400)
    return successResponse({ reported: true }, 201)
  } catch (error) {
    logger.error("Report room member error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to submit report")
  }
}
