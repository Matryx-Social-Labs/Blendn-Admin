import { NextRequest } from "next/server"

import { isUuid } from "@/lib/api-input"
import { notFoundResponse, serverErrorResponse, successResponse, unauthorizedResponse } from "@/lib/api-response"
import { revokeCrewLink } from "@/lib/crews/links"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"

interface RouteParams {
  params: Promise<{ crewId: string; token: string }>
}

/** DELETE /api/mobile/crews/:crewId/links/:token — revoke an unused link: its sharer or the crew's owner. 404 otherwise. */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const limited = await rateLimit(request, userLimit("write", "crew-link", authUser.userId))
    if (limited) return limited

    const { crewId, token } = await params
    if (!isUuid(crewId) || !(await revokeCrewLink(authUser.userId, crewId, token))) return notFoundResponse("Link not found")
    return successResponse({ revoked: true })
  } catch (error) {
    logger.error("Crew link revoke error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to revoke the link")
  }
}
