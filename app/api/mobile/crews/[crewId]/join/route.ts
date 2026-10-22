import { NextRequest } from "next/server"

import { isUuid, readJson } from "@/lib/api-input"
import {
  notFoundResponse,
  serverErrorResponse,
  successResponse,
  unauthorizedResponse,
  validationErrorResponse,
} from "@/lib/api-response"
import { acceptCrewInvite, declineCrewInvite, isRefusal, joinCrewSchema, refusalResponse } from "@/lib/crews/crews"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"

interface RouteParams {
  params: Promise<{ crewId: string }>
}

/**
 * POST /api/mobile/crews/:crewId/join — accept my invite. `revealConsent:
 * true` is required: "anyone in this crew can reveal the crew — your name and
 * photos — to people you match with". `keepMeAnonymous` is the personal
 * override. 404 with no open invite; 409 when the crew is already full.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const limited = await rateLimit(request, userLimit("write", "crew-join", authUser.userId))
    if (limited) return limited

    const { crewId } = await params
    if (!isUuid(crewId)) return notFoundResponse("Crew not found")
    const parsed = joinCrewSchema.safeParse(await readJson(request))
    if (!parsed.success) return validationErrorResponse(parsed.error)

    const joined = await acceptCrewInvite(authUser.userId, crewId, parsed.data)
    if (isRefusal(joined)) return refusalResponse(joined)
    return successResponse(joined)
  } catch (error) {
    logger.error("Crew join error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to join the crew")
  }
}

/**
 * DELETE /api/mobile/crews/:crewId/join — decline my invite. Nobody is told;
 * the invite stops showing, and asking again will not re-notify me.
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const limited = await rateLimit(request, userLimit("write", "crew-join", authUser.userId))
    if (limited) return limited

    const { crewId } = await params
    if (!isUuid(crewId) || !(await declineCrewInvite(authUser.userId, crewId))) return notFoundResponse("Crew not found")
    return successResponse({ declined: true })
  } catch (error) {
    logger.error("Crew decline error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to decline")
  }
}
