import { NextRequest } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, createBatchRateLimit } from "@/lib/rate-limit"
import {
  successResponse,
  unauthorizedResponse,
  validationErrorResponse,
  serverErrorResponse,
} from "@/lib/api-response"

const batchInterestsSchema = z.object({
  eventIds: z.array(z.string().uuid()).min(1).max(50),
})

export async function POST(request: NextRequest) {
  const rateLimitResult = rateLimit(request, createBatchRateLimit())
  if (rateLimitResult) return rateLimitResult

  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    const body = await request.json()
    const parsed = batchInterestsSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }

    const { eventIds } = parsed.data

    // Get all favorites (interests) for the user in the specified events
    const favorites = await db.event_favorites.findMany({
      where: {
        user_id: authUser.userId,
        event_id: { in: eventIds },
      },
      select: {
        event_id: true,
      },
    })

    // Build interests map
    const interests: Record<string, boolean> = {}

    // Initialize all eventIds as not interested
    for (const eventId of eventIds) {
      interests[eventId] = false
    }

    // Mark events user is interested in
    for (const favorite of favorites) {
      interests[favorite.event_id] = true
    }

    return successResponse({ interests })
  } catch (error) {
    console.error("Batch interest status error:", error)
    return serverErrorResponse("Failed to get interest statuses")
  }
}
