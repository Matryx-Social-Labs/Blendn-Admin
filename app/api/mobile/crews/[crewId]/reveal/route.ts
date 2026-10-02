import { NextRequest } from "next/server"
import { z } from "zod"

import { isUuid, readJson } from "@/lib/api-input"
import {
  notFoundResponse,
  serverErrorResponse,
  successResponse,
  unauthorizedResponse,
  validationErrorResponse,
} from "@/lib/api-response"
import { revealCrewAt } from "@/lib/crews/blends"
import { isRefusal, refusalResponse } from "@/lib/crews/crews"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"

interface RouteParams {
  params: Promise<{ crewId: string }>
}

const revealSchema = z.object({ eventId: z.string().uuid() }).strict()

/**
 * POST /api/mobile/crews/:crewId/reveal — one tap reveals the crew at this
 * event (in its Blend or its room): every member there who consented on
 * joining and has not switched on "keep me anonymous". Each is written as
 * their own per-event reveal. `{ revealed, keptPrivate }`.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const limited = await rateLimit(request, userLimit("write", "crew-reveal", authUser.userId))
    if (limited) return limited

    const { crewId } = await params
    if (!isUuid(crewId)) return notFoundResponse("Crew not found")
    const parsed = revealSchema.safeParse(await readJson(request))
    if (!parsed.success) return validationErrorResponse(parsed.error)

    const result = await revealCrewAt(authUser.userId, crewId, parsed.data.eventId)
    return isRefusal(result) ? refusalResponse(result) : successResponse(result)
  } catch (error) {
    logger.error("Crew reveal error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to reveal the crew")
  }
}
