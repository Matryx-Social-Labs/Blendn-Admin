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

    const favorited = new Set(favorites.map((f) => f.event_id))
    const interests: Record<string, boolean> = Object.fromEntries(eventIds.map((id) => [id, favorited.has(id)]))

    return successResponse({ interests })
  } catch (error) {
    logger.error("Batch interest status error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to get interest statuses")
  }
}
