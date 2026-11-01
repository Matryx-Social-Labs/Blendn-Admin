import { NextRequest } from "next/server"
import { z } from "zod"

import { ageFrom, isAdult, mayParticipate } from "@/lib/age"
import {
  serverErrorResponse,
  successResponse,
  unauthorizedResponse,
  validationErrorResponse,
} from "@/lib/api-response"
import { viewerCityRule } from "@/lib/browse-scope"
import { db } from "@/lib/db"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { venueSummary } from "@/lib/venue-summary"

/** `lat` and `lon` are the list's vocabulary and are accepted and ignored: the counts are of the city, not of a radius. */
const summaryQuerySchema = z.object({
  city: z.string().min(1).max(100).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
})

/**
 * Places' counts: by venue type and by area, for a city (`lib/venue-summary.ts`).
 * Counts of places, never of people, over exactly the venues
 * `GET /api/mobile/venues` lists for the same viewer. Kept 60 s per city.
 */
export async function GET(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }
    // The list's limit: the same reads sit under it.
    const limited = await rateLimit(request, userLimit("read", "venues-summary", authUser.userId))
    if (limited) return limited

    const parsed = summaryQuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams))
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }

    const viewer = await db.profiles.findUnique({
      where: { id: authUser.userId },
      select: { age: true, date_of_birth: true, onboarded: true },
    })
    const viewerAge = ageFrom(viewer)
    const summary = await venueSummary(
      {
        cityRule: await viewerCityRule(authUser.userId, parsed.data.city),
        userId: authUser.userId,
        viewerAge: typeof viewerAge === "number" ? viewerAge : null,
        // The venue page's own gate, as the list's `liveNow`: anyone else is counted no live venue.
        mayCountLive: mayParticipate(viewer) && isAdult(viewerAge),
      },
      new Date()
    )
    return successResponse(summary)
  } catch (error) {
    logger.error("Venue summary error", { error: String(error) })
    return serverErrorResponse("Failed to summarise venues")
  }
}
