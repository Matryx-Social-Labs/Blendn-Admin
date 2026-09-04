import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import {
  successResponse,
  validationErrorResponse,
  unauthorizedResponse,
  notFoundResponse,
  serverErrorResponse,
} from "@/lib/api-response"

interface RouteParams {
  params: Promise<{ eventId: string }>
}

/**
 * Report an event.
 *
 * `event_reports` has existed with zero writers and zero readers, which meant
 * that somebody who wanted to report an unsafe venue, a misleading listing or a
 * dangerous organiser had **no path at all**. They could report a person and
 * they could report a message; the event itself — the thing they are being
 * asked to physically turn up to — was the one subject with nothing behind it.
 *
 * That is a strange gap in a product whose stated difference from an anonymous
 * board is that somebody is accountable for the room, and it is the sixth
 * instance of the same shape: a table modelled, indexed, and never connected to
 * either end.
 *
 * No attendance requirement, deliberately. Two of the three things worth
 * reporting — a misleading listing and a dangerous-looking organiser — are
 * visible from the listing, and the whole value is catching them *before*
 * somebody travels to a venue. Requiring a check-in would restrict reporting to
 * people who already took the risk.
 *
 * Repeat reports are allowed rather than deduped. A second report from the same
 * person usually means they have seen something worse, and suppressing it to
 * keep the queue tidy is the wrong trade in this direction. The rate limit is
 * what bounds abuse.
 */
const reportEventSchema = z.object({
  reason: z.string().min(1, "Reason is required"),
  description: z.string().max(2000).optional(),
})

// POST /api/mobile/events/[eventId]/report — Report an event
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Authentication required")
    }

    const limited = await rateLimit(request, userLimit("safety", "report-event", authUser.userId))
    if (limited) return limited

    const { eventId } = await params

    const body = await request.json()
    const validation = reportEventSchema.safeParse(body)
    if (!validation.success) {
      return validationErrorResponse(validation.error)
    }

    /*
     * `deleted_at` is not filtered. An event taken down between somebody
     * deciding to report it and the request arriving is exactly the event worth
     * hearing about, and refusing there would drop the evidence.
     */
    const event = await db.events.findUnique({
      where: { id: eventId },
      select: { id: true },
    })
    if (!event) {
      return notFoundResponse("Event not found")
    }

    await db.event_reports.create({
      data: {
        event_id: eventId,
        user_id: authUser.userId,
        reason: validation.data.reason,
        description: validation.data.description,
      },
    })

    return successResponse({ reported: true }, 201)
  } catch (error) {
    logger.error("Report event error", {
      error: error instanceof Error ? error.message : String(error),
    })
    return serverErrorResponse("Failed to submit report")
  }
}
