import { NextRequest } from "next/server"

import { isUuid } from "@/lib/api-input"
import { notFoundResponse, serverErrorResponse, successResponse, unauthorizedResponse } from "@/lib/api-response"
import { isRefusal, refusalResponse } from "@/lib/crews/crews"
import { createCrewLink } from "@/lib/crews/links"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"

interface RouteParams {
  params: Promise<{ crewId: string }>
}

/**
 * POST /api/mobile/crews/:crewId/links — a single-use invite link into this
 * crew (S7), `{ token, url, expiresAt }`, for any active member. 404 for
 * anybody else; 429 past `CREW.LINKS_PER_WINDOW` a day (lib/crews/links.ts).
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const limited = await rateLimit(request, userLimit("write", "crew-link", authUser.userId))
    if (limited) return limited

    const { crewId } = await params
    if (!isUuid(crewId)) return notFoundResponse("Crew not found")
    const made = await createCrewLink(authUser.userId, crewId)
    return isRefusal(made) ? refusalResponse(made) : successResponse(made, 201)
  } catch (error) {
    logger.error("Crew link error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to make the link")
  }
}
