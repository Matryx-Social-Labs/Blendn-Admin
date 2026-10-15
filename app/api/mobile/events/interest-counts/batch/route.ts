import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, createBatchRateLimit } from "@/lib/rate-limit"
import {
  successResponse,
  unauthorizedResponse,
  validationErrorResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { readJson } from "@/lib/api-input"
import { eventIdsBatchSchema } from "@/lib/validations/event"

export async function POST(request: NextRequest) {
  const rateLimitResult = await rateLimit(request, createBatchRateLimit())
  if (rateLimitResult) return rateLimitResult

  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    const body = await readJson(request)
    const parsed = eventIdsBatchSchema.safeParse(body)
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

    const counted = new Map(favoriteCounts.map((item) => [item.event_id, item._count.event_id]))
    const counts: Record<string, number> = Object.fromEntries(eventIds.map((id) => [id, counted.get(id) ?? 0]))

    return successResponse({ counts })
  } catch (error) {
    logger.error("Batch interest count error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to get interest counts")
  }
}
