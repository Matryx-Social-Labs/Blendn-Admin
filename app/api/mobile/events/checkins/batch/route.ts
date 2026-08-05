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

const batchCheckinsSchema = z.object({
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
    const parsed = batchCheckinsSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }

    const { eventIds } = parsed.data

    // Get all check-ins for the user in the specified events
    const checkIns = await db.event_check_ins.findMany({
      where: {
        user_id: authUser.userId,
        event_id: { in: eventIds },
      },
      select: {
        event_id: true,
        id: true,
        status: true,
        check_in_time: true,
      },
    })

    // Build status map
    const statuses: Record<
      string,
      { status: string; checkInId?: string; checkInTime?: Date | null }
    > = {}

    // Initialize all eventIds with no check-in status
    for (const eventId of eventIds) {
      statuses[eventId] = { status: "none" }
    }

    // Populate with actual check-in data
    for (const checkIn of checkIns) {
      statuses[checkIn.event_id] = {
        status: checkIn.status,
        checkInId: checkIn.id,
        checkInTime: checkIn.check_in_time,
      }
    }

    return successResponse({ statuses })
  } catch (error) {
    logger.error("Batch check-in status error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to get check-in statuses")
  }
}
