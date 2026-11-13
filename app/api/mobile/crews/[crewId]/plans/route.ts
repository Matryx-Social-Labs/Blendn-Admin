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
import { planNight, unplanNight } from "@/lib/crews/plans"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"

interface RouteParams {
  params: Promise<{ crewId: string }>
}

const planSchema = z.object({ eventId: z.string().uuid() }).strict()

async function handle(request: NextRequest, { params }: RouteParams, act: typeof planNight | typeof unplanNight) {
  const authUser = await getAuthenticatedUser(request)
  if (!authUser) return unauthorizedResponse("Invalid or expired token")
  const limited = await rateLimit(request, userLimit("write", "crew-plan", authUser.userId))
  if (limited) return limited
  const { crewId } = await params
  if (!isUuid(crewId)) return notFoundResponse("Crew not found")
  const parsed = planSchema.safeParse(await readJson(request))
  if (!parsed.success) return validationErrorResponse(parsed.error)
  const result = await act(authUser.userId, crewId, parsed.data.eventId)
  return isRefusal(result) ? refusalResponse(result) : successResponse(result)
}

/**
 * POST /api/mobile/crews/:crewId/plans — "Going together" (crews 4-A1): the
 * crew marks the event's next night. One line in the crew chat and one push
 * to the rest of the crew, once per night; `repeated: true` after that.
 */
export async function POST(request: NextRequest, ctx: RouteParams) {
  try {
    return await handle(request, ctx, planNight)
  } catch (error) {
    logger.error("Crew plan error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to plan the night")
  }
}

/** DELETE /api/mobile/crews/:crewId/plans — take the plan back (whoever marked it, or the owner). Nobody is told. */
export async function DELETE(request: NextRequest, ctx: RouteParams) {
  try {
    return await handle(request, ctx, unplanNight)
  } catch (error) {
    logger.error("Crew unplan error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to take the plan back")
  }
}
