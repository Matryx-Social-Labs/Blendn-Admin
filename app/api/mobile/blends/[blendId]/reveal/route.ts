import { NextRequest } from "next/server"

import { isUuid } from "@/lib/api-input"
import { notFoundResponse, serverErrorResponse, successResponse, unauthorizedResponse } from "@/lib/api-response"
import { revealInBlend } from "@/lib/crews/blends"
import { isRefusal, refusalResponse } from "@/lib/crews/crews"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"

interface RouteParams {
  params: Promise<{ blendId: string }>
}

/**
 * POST /api/mobile/blends/:blendId/reveal — one tap reveals my crew in this
 * Blend, and only here: each member of my crew who is checked in now and in
 * this Blend's room, except anybody keeping themselves anonymous. The matched
 * person in a crew ↔ person Blend reveals only themselves. Shown to this
 * Blend's people and nobody else — not the event's room, its deck or a DM.
 * `{ revealed, keptPrivate }`. 404 for a Blend that is not open or not mine.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const limited = await rateLimit(request, userLimit("write", "blend-reveal", authUser.userId))
    if (limited) return limited

    const { blendId } = await params
    if (!isUuid(blendId)) return notFoundResponse("Blend not found")
    const result = await revealInBlend(authUser.userId, blendId)
    return isRefusal(result) ? refusalResponse(result) : successResponse(result)
  } catch (error) {
    logger.error("Blend reveal error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to reveal")
  }
}
