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
import { isRefusal, refusalResponse } from "@/lib/crews/crews"
import { crewHere } from "@/lib/crews/presence"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"

interface RouteParams {
  params: Promise<{ crewId: string }>
}

const hereSchema = z.object({ eventId: z.string().uuid() }).strict()

/**
 * POST /api/mobile/crews/:crewId/here — "We're here". I must be checked in at
 * the event now; nobody else is checked in by it. A line in the crew chat, and
 * a push to every other member, once per night (`repeated: true` after that).
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const limited = await rateLimit(request, userLimit("write", "crew-here", authUser.userId))
    if (limited) return limited

    const { crewId } = await params
    if (!isUuid(crewId)) return notFoundResponse("Crew not found")
    const parsed = hereSchema.safeParse(await readJson(request))
    if (!parsed.success) return validationErrorResponse(parsed.error)

    const result = await crewHere(authUser.userId, crewId, parsed.data.eventId)
    if (isRefusal(result)) return refusalResponse(result)
    return successResponse(result)
  } catch (error) {
    logger.error("Crew here error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to tell the crew")
  }
}
