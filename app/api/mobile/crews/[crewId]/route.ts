import { NextRequest } from "next/server"

import { isUuid, readJson } from "@/lib/api-input"
import {
  notFoundResponse,
  serverErrorResponse,
  successResponse,
  unauthorizedResponse,
  validationErrorResponse,
} from "@/lib/api-response"
import { isRefusal, refusalResponse, updateCrew, updateCrewSchema } from "@/lib/crews/crews"
import { crewDetail } from "@/lib/crews/views"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"

interface RouteParams {
  params: Promise<{ crewId: string }>
}

/**
 * GET /api/mobile/crews/:crewId — one of my crews: its members by first name
 * and photo, each by their handle in the crew's room. A crew I am not in is
 * the same 404 as one that does not exist.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const limited = await rateLimit(request, userLimit("read", "crew-detail", authUser.userId))
    if (limited) return limited
    const { crewId } = await params
    const crew = isUuid(crewId) ? await crewDetail(authUser.userId, crewId) : null
    return crew ? successResponse(crew) : notFoundResponse("Crew not found")
  } catch (error) {
    logger.error("Get crew error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to load the crew")
  }
}

/**
 * PATCH /api/mobile/crews/:crewId — the owner edits the crew: name, bio,
 * intent, tags, "room for one more". The name and bio are checked as at
 * creation.
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const limited = await rateLimit(request, userLimit("write", "crew-edit", authUser.userId))
    if (limited) return limited

    const { crewId } = await params
    if (!isUuid(crewId)) return notFoundResponse("Crew not found")
    const parsed = updateCrewSchema.safeParse(await readJson(request))
    if (!parsed.success) return validationErrorResponse(parsed.error)

    const updated = await updateCrew(authUser.userId, crewId, parsed.data)
    if (isRefusal(updated)) return refusalResponse(updated)
    return successResponse(await crewDetail(authUser.userId, crewId))
  } catch (error) {
    logger.error("Edit crew error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to edit the crew")
  }
}
