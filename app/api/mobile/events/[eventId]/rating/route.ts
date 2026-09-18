import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import {
  successResponse,
  validationErrorResponse,
  unauthorizedResponse,
  notFoundResponse,
  errorResponse,
  ErrorCode,
  serverErrorResponse,
} from "@/lib/api-response"
import { ratingSchema } from "@/lib/validations/event"

interface RouteParams {
  params: Promise<{ eventId: string }>
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { eventId } = await params

    // Get authenticated user
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    const limited = await rateLimit(request, userLimit("write", "rating", authUser.userId))
    if (limited) return limited

    const body = await request.json()

    // Validate input
    const parsed = ratingSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }

    const { rating, review } = parsed.data

    const event = await db.events.findUnique({
      where: { id: eventId, deleted_at: null },
      select: { id: true, status: true, end_time: true },
    })

    if (!event) {
      return notFoundResponse("Event not found")
    }

    /*
     * Attendance, not presence — the same distinction `mayWriteToRoom` draws.
     *
     * This required `status === "checked_in"`, which is *are you here right
     * now*: manual check-out and the sweeper's auto-checkout at the end of the
     * night both flip it to `checked_out`. So the one moment a rating is
     * meant for — afterwards, on the way home — was the one moment it was
     * refused. On staging 48 of 48 past check-ins were `checked_out` and
     * `event_ratings` had never received a row (SCRUM-181).
     *
     * And only once the night is over: a rating during the event is leverage
     * (the peer rating says the same, `docs/API.md`), and the organiser's
     * Feedback page reads it as a verdict.
     */
    const checkIn = await db.event_check_ins.findFirst({
      // Event-level: you may rate an event you attended on any of its days.
      where: { event_id: eventId, user_id: authUser.userId },
      select: { id: true },
    })
    if (!checkIn) {
      return errorResponse("You can rate an event you checked in to", 403, ErrorCode.FORBIDDEN)
    }
    if (event.end_time.getTime() > Date.now()) {
      return errorResponse("You can rate this event once it has ended", 403, ErrorCode.FORBIDDEN)
    }

    // Create or update rating
    const eventRating = await db.event_ratings.upsert({
      where: {
        event_id_user_id: {
          event_id: eventId,
          user_id: authUser.userId,
        },
      },
      // `?? null`, not the bare optional: `strictUndefinedChecks` refuses an
      // explicit undefined, so a stars-only rating — the common one — 500'd.
      // Found by the itest the day the gate was fixed (SCRUM-181).
      create: {
        event_id: eventId,
        user_id: authUser.userId,
        rating,
        review: review ?? null,
      },
      update: {
        rating,
        review: review ?? null,
        updated_at: new Date(),
      },
    })

    // Calculate new average rating
    const avgRating = await db.event_ratings.aggregate({
      where: { event_id: eventId },
      _avg: { rating: true },
      _count: true,
    })

    return successResponse({
      rating: {
        id: eventRating.id,
        rating: eventRating.rating,
        review: eventRating.review,
        createdAt: eventRating.created_at,
        updatedAt: eventRating.updated_at,
      },
      eventStats: {
        averageRating: avgRating._avg.rating,
        ratingCount: avgRating._count,
      },
      message: "Rating submitted successfully",
    })
  } catch (error) {
    logger.error("Rate event error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to rate event")
  }
}
