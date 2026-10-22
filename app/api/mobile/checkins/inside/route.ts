import { NextRequest } from "next/server"

import { readJson } from "@/lib/api-input"
import { serverErrorResponse, successResponse, unauthorizedResponse, validationErrorResponse } from "@/lib/api-response"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { placesInside } from "@/lib/places-inside"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { checkinSchema } from "@/lib/validations/event"

/**
 * `POST /checkins/inside` — the places this person is inside now, judged as the
 * doors judge them, in the order the pass docks (SCRUM-704, `lib/places-inside.ts`).
 *
 * A POST with the position in the body, never a GET with it in the query
 * string: a URL is logged at every hop, and a person's coordinates have no
 * business in an access log.
 *
 * Rate limited like the doors themselves (the `safety` shape, its own scope):
 * the answer is a yes or no per fence, and asked from enough points it draws a
 * venue's area, which nobody is shown (D-x6).
 */
export async function POST(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")

    const limited = await rateLimit(request, userLimit("safety", "places-inside", authUser.userId))
    if (limited) return limited

    const parsed = checkinSchema.safeParse(await readJson(request))
    if (!parsed.success) return validationErrorResponse(parsed.error)
    const { latitude, longitude, deviceInfo } = parsed.data
    return successResponse(await placesInside(authUser.userId, { lat: latitude, lng: longitude }, deviceInfo?.gpsAccuracy))
  } catch (error) {
    logger.error("Places inside error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to find where you are")
  }
}
