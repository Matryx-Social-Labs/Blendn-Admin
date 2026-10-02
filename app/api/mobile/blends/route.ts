import { NextRequest } from "next/server"

import { serverErrorResponse, successResponse, unauthorizedResponse } from "@/lib/api-response"
import { blendsOf } from "@/lib/crews/blends"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"

/**
 * GET /api/mobile/blends — my open Blends: each one's room, its clock, and its
 * two sides — the people here on each by tonight's pseudonym, named only
 * where the event's room would name them, with "N revealed · M keep it
 * private" per crew.
 */
export async function GET(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    return successResponse(await blendsOf(authUser.userId))
  } catch (error) {
    logger.error("List blends error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to load your Blends")
  }
}
