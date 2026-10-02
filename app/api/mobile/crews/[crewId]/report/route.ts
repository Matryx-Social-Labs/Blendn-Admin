import { NextRequest } from "next/server"

import { isUuid, readJson } from "@/lib/api-input"
import {
  notFoundResponse,
  serverErrorResponse,
  successResponse,
  unauthorizedResponse,
  validationErrorResponse,
} from "@/lib/api-response"
import { isRefusal, refusalResponse, reportCrew, reportCrewSchema } from "@/lib/crews/crews"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"

interface RouteParams {
  params: Promise<{ crewId: string }>
}

/**
 * POST /api/mobile/crews/:crewId/report — report a crew's card: its name or
 * bio (`reason`: spam, offensive, contact_details, impersonation, other).
 * Reaches the admin queue, where a moderator can hide the crew or dissolve it.
 * Nobody in the crew is told. 201 whether or not it was the first report from
 * you; 404 for a crew that is not there. Capped per minute and per day, as
 * every report is.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const limited =
      (await rateLimit(request, userLimit("safety", "report-crew", authUser.userId))) ??
      (await rateLimit(request, userLimit("reportDay", "report-crew-day", authUser.userId)))
    if (limited) return limited

    const { crewId } = await params
    if (!isUuid(crewId)) return notFoundResponse("Crew not found")
    const parsed = reportCrewSchema.safeParse(await readJson(request))
    if (!parsed.success) return validationErrorResponse(parsed.error)

    const result = await reportCrew(authUser.userId, crewId, parsed.data)
    if (isRefusal(result)) return refusalResponse(result)
    return successResponse(result, 201)
  } catch (error) {
    logger.error("Crew report error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to submit report")
  }
}
