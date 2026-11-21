import { NextRequest } from "next/server"

import { isUuid } from "@/lib/api-input"
import { notFoundResponse, serverErrorResponse, successResponse, unauthorizedResponse } from "@/lib/api-response"
import { isRefusal, refusalResponse } from "@/lib/crews/crews"
import { hideCrew, unhideCrew } from "@/lib/crews/hides"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"

interface RouteParams {
  params: Promise<{ crewId: string }>
}

/**
 * POST /api/mobile/crews/:crewId/hide — "Block" on a crew: hide it from you for
 * good (`lib/crews/hides.ts`). `{ hidden: true }`; 404 for a crew that is not
 * there, has ended, or is yours. Nobody is told.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  return answer(request, params, (userId, crewId) => hideCrew(userId, crewId))
}

/** DELETE /api/mobile/crews/:crewId/hide — show it again. `{ hidden: false }`, whether or not it was hidden. */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  return answer(request, params, (userId, crewId) => unhideCrew(userId, crewId))
}

async function answer(
  request: NextRequest,
  params: RouteParams["params"],
  act: (userId: string, crewId: string) => ReturnType<typeof hideCrew> | ReturnType<typeof unhideCrew>
) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const limited = await rateLimit(request, userLimit("safety", "crew-hide", authUser.userId))
    if (limited) return limited
    const { crewId } = await params
    if (!isUuid(crewId)) return notFoundResponse("Crew not found")
    const result = await act(authUser.userId, crewId)
    return isRefusal(result) ? refusalResponse(result) : successResponse(result)
  } catch (error) {
    logger.error("Crew hide error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to hide the crew")
  }
}
