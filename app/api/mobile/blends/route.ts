import { NextRequest } from "next/server"

import { serverErrorResponse, successResponse, unauthorizedResponse } from "@/lib/api-response"
import { blendsOf } from "@/lib/crews/blends"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"

/**
 * GET /api/mobile/blends — my open Blends: each one's room, its clock, and its
 * two sides — the people who were here when it matched, by tonight's
 * pseudonym, named only when revealed in this Blend (or recognised in the
 * event's room), with "N revealed · M keep it private" per crew. Never
 * somebody kept apart from me, nor somebody who turned "show online" off.
 */
export async function GET(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const limited = await rateLimit(request, userLimit("read", "blends", authUser.userId))
    if (limited) return limited
    return successResponse(await blendsOf(authUser.userId))
  } catch (error) {
    logger.error("List blends error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to load your Blends")
  }
}
