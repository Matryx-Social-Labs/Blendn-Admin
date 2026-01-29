import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import {
  successResponse,
  validationErrorResponse,
  unauthorizedResponse,
  notFoundResponse,
  errorResponse,
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

    const body = await request.json()

    // Validate input
    const parsed = ratingSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }

    const { rating, review } = parsed.data

    // Check if event exists
    const event = await db.events.findUnique({
      where: { id: eventId, deleted_at: null },
      select: { id: true, status: true },
    })

    if (!event) {
      return notFoundResponse("Event not found")
    }

    // Check if user was checked in to this event
    const checkIn = await db.event_check_ins.findUnique({
      where: {
        event_id_user_id: {
          event_id: eventId,
          user_id: authUser.userId,
        },
      },
    })

    if (!checkIn || checkIn.status !== "checked_in") {
      return errorResponse("You must check in to an event before rating it")
    }

    // Create or update rating
    const eventRating = await db.event_ratings.upsert({
      where: {
        event_id_user_id: {
          event_id: eventId,
          user_id: authUser.userId,
        },
      },
      create: {
        event_id: eventId,
        user_id: authUser.userId,
        rating,
        review,
      },
      update: {
        rating,
        review,
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
    console.error("Rate event error:", error)
    return serverErrorResponse("Failed to rate event")
  }
}
