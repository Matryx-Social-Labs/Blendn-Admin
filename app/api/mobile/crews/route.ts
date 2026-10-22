import { NextRequest } from "next/server"

import { readJson } from "@/lib/api-input"
import { errorResponse, serverErrorResponse, successResponse, unauthorizedResponse, validationErrorResponse } from "@/lib/api-response"
import { createCrew, createCrewSchema, isRefusal, refusalResponse } from "@/lib/crews/crews"
import { crewsOf } from "@/lib/crews/views"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { LEGACY_PAGE, LIST_PAGE, parseListQuery } from "@/lib/pagination"
import { rateLimit, userLimit } from "@/lib/rate-limit"

/**
 * GET /api/mobile/crews — my crews, and the crew invites waiting for me: the
 * newest 200, a page at a time (`?limit=&cursor=`, `invitesPagination`).
 */
export async function GET(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const limited = await rateLimit(request, userLimit("read", "crews-list", authUser.userId))
    if (limited) return limited
    // The invites page: `?limit=` (default 50) and `?cursor=`; neither is an installed build, answered with up to 200.
    const invites = parseListQuery(request.nextUrl.searchParams, LIST_PAGE.REQUESTS, LEGACY_PAGE)
    if (invites === "bad_cursor") return errorResponse("Invalid cursor", 400)
    return successResponse(await crewsOf(authUser.userId, invites))
  } catch (error) {
    logger.error("List crews error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to load crews")
  }
}

/**
 * POST /api/mobile/crews — make a crew, with me as its owner, and invite
 * friends into it. `revealConsent: true` is required: joining a crew is
 * agreeing that anyone in it can reveal the crew (lib/crews/crews.ts).
 */
export async function POST(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")

    const limited = await rateLimit(request, userLimit("heavy", "crew-create", authUser.userId))
    if (limited) return limited

    const parsed = createCrewSchema.safeParse(await readJson(request))
    if (!parsed.success) return validationErrorResponse(parsed.error)

    const created = await createCrew(authUser.userId, parsed.data)
    if (isRefusal(created)) return refusalResponse(created)
    return successResponse(created, 201)
  } catch (error) {
    logger.error("Create crew error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to create the crew")
  }
}
