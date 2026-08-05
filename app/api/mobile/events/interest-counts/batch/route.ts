import { logger } from "@/lib/logger"
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

const batchInterestCountsSchema = z.object({
  eventIds: z.array(z.string().uuid()).min(1).max(50),
})

export async function POST(request: NextRequest) {
  const rateLimitResult = await rateLimit(request, createBatchRateLimit())
  if (rateLimitResult) return rateLimitResult

  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    const body = await request.json()
    const parsed = batchInterestCountsSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }

    const { eventIds } = parsed.data

    // Get counts for all events using groupBy
    const favoriteCounts = await db.event_favorites.groupBy({
      by: ["event_id"],
      where: {
        event_id: { in: eventIds },
      },
      _count: {
        event_id: true,
      },
    })

    // Build counts map
    const counts: Record<string, number> = {}

    // Initialize all eventIds with 0
    for (const eventId of eventIds) {
      counts[eventId] = 0
    }

    // Populate with actual counts
    for (const item of favoriteCounts) {
      counts[item.event_id] = item._count.event_id
    }

    return successResponse({ counts })
  } catch (error) {
    logger.error("Batch interest count error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to get interest counts")
  }
}
