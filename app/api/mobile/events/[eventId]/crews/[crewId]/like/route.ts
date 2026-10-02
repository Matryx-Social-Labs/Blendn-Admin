import { NextRequest } from "next/server"
import { z } from "zod"

import { isUuid, readOptionalJson } from "@/lib/api-input"
import {
  notFoundResponse,
  serverErrorResponse,
  successResponse,
  unauthorizedResponse,
  validationErrorResponse,
} from "@/lib/api-response"
import { isRefusal, refusalResponse } from "@/lib/crews/crews"
import { likeCrew } from "@/lib/crews/like"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"

interface RouteParams {
  params: Promise<{ eventId: string; crewId: string }>
}

const likeSchema = z.object({ asCrewId: z.string().uuid().optional() }).strict()

/**
 * POST /api/mobile/events/:eventId/crews/:crewId/like — like a crew here now:
 * as one of your crews here (`asCrewId`, any present member on the crew's
 * behalf), or as yourself (crew ↔ person, with its guardrails). A like back
 * makes one Blend: `{ liked: true, blend }`. Never says who liked first.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const limited = await rateLimit(request, userLimit("write", "crew-like", authUser.userId))
    if (limited) return limited

    const { eventId, crewId } = await params
    if (!isUuid(eventId) || !isUuid(crewId)) return notFoundResponse("Crew not found")
    const parsed = likeSchema.safeParse(await readOptionalJson(request))
    if (!parsed.success) return validationErrorResponse(parsed.error)

    const outcome = await likeCrew(authUser.userId, eventId, crewId, parsed.data.asCrewId)
    return isRefusal(outcome) ? refusalResponse(outcome) : successResponse(outcome)
  } catch (error) {
    logger.error("Crew like error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to record the like")
  }
}
