import { NextRequest } from "next/server"

import { isUuid, readJson } from "@/lib/api-input"
import {
  notFoundResponse,
  serverErrorResponse,
  successResponse,
  unauthorizedResponse,
  validationErrorResponse,
} from "@/lib/api-response"
import { inviteSchema, inviteToCrew, isRefusal, refusalResponse } from "@/lib/crews/crews"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"

interface RouteParams {
  params: Promise<{ crewId: string }>
}

/**
 * POST /api/mobile/crews/:crewId/invites — any member invites their friends.
 * Every one must be the inviter's friend (the same 404 otherwise, whoever
 * they are); somebody already in or already invited is skipped without
 * re-notifying them; 409 when the open invites would take the crew past 12.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const limited = await rateLimit(request, userLimit("write", "crew-invite", authUser.userId))
    if (limited) return limited

    const { crewId } = await params
    if (!isUuid(crewId)) return notFoundResponse("Crew not found")
    const parsed = inviteSchema.safeParse(await readJson(request))
    if (!parsed.success) return validationErrorResponse(parsed.error)

    const result = await inviteToCrew(authUser.userId, crewId, parsed.data.userIds)
    if (isRefusal(result)) return refusalResponse(result)
    return successResponse(result)
  } catch (error) {
    logger.error("Crew invite error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to invite")
  }
}
