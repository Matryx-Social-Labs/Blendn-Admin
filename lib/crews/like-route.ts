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
import { roomBanRefusal } from "@/lib/room-ban"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"

interface RouteParams {
  params: Promise<{ eventId: string; crewId: string }>
}

const bodySchema = z.object({ asCrewId: z.string().uuid().optional() }).strict()

/**
 * The like and the wave of a crew here now: one door, one writer
 * (`likeCrew`), the same limiters. Likes and waves share the 30-a-day bucket
 * (decided per advisor, 2026-11-21: never counted twice, and not in the
 * person Wave's W3/W4).
 */
export function crewGestureHandler(wave: boolean) {
  return async function POST(request: NextRequest, { params }: RouteParams) {
    try {
      const authUser = await getAuthenticatedUser(request)
      if (!authUser) return unauthorizedResponse("Invalid or expired token")
      const limited =
        (await rateLimit(request, userLimit("write", "crew-like", authUser.userId))) ??
        // 30 a day (SCRUM-1050), counted at the door so a refused one counts as a landed one: no answer below tells them apart.
        (await rateLimit(request, userLimit("crewLikeDay", "crew-like-day", authUser.userId)))
      if (limited) return limited

      const { eventId, crewId } = await params
      if (!isUuid(eventId) || !isUuid(crewId)) return notFoundResponse("Crew not found")
      // A host's ban closes the room's people as it closes its chat (`roomBanRefusal`).
      const banned = await roomBanRefusal(eventId, authUser.userId)
      if (banned) return banned
      const parsed = bodySchema.safeParse(await readOptionalJson(request))
      if (!parsed.success) return validationErrorResponse(parsed.error)

      const outcome = await likeCrew(authUser.userId, eventId, crewId, parsed.data.asCrewId, { wave })
      return isRefusal(outcome) ? refusalResponse(outcome) : successResponse(outcome)
    } catch (error) {
      logger.error(wave ? "Crew wave error" : "Crew like error", { error: error instanceof Error ? error.message : String(error) })
      return serverErrorResponse(wave ? "Failed to record the wave" : "Failed to record the like")
    }
  }
}
