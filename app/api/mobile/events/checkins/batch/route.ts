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

    // Last row wins for an event, as the loop this replaced did.
    const byEvent = new Map(checkIns.map((c) => [c.event_id, c]))
    const statuses: Record<string, { status: string; checkInId?: string; checkInTime?: Date | null }> =
      Object.fromEntries(
        eventIds.map((id) => {
          const c = byEvent.get(id)
          return [id, c ? { status: c.status, checkInId: c.id, checkInTime: c.check_in_time } : { status: "none" }]
        })
      )

    return successResponse({ statuses })
  } catch (error) {
    logger.error("Batch check-in status error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to get check-in statuses")
  }
}
