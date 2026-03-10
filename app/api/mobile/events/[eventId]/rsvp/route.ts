import { NextRequest } from "next/server"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { db } from "@/lib/db"
import {
  successResponse,
  errorResponse,
  unauthorizedResponse,
  notFoundResponse,
  serverErrorResponse,
} from "@/lib/api-response"

const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> }
) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return unauthorizedResponse("Authentication required")

    const { eventId } = await params
    if (!uuidRegex.test(eventId)) return errorResponse("Invalid event ID format", 400)

    const event = await db.events.findUnique({
      where: { id: eventId, deleted_at: null },
      select: { id: true },
    })
    if (!event) return notFoundResponse("Event not found")

    const body = await request.json()
    const status: "going" | "maybe" | "not_going" = body.status || "going"

    if (!["going", "maybe", "not_going"].includes(status)) {
      return errorResponse("Invalid RSVP status", 400)
    }

    const rsvp = await db.event_rsvps.upsert({
      where: {
        event_id_user_id: { event_id: eventId, user_id: user.userId },
      },
      create: { event_id: eventId, user_id: user.userId, status },
      update: { status, updated_at: new Date() },
    })

    const rsvpCount = await db.event_rsvps.count({
      where: { event_id: eventId, status: "going" },
    })

    return successResponse({ rsvpStatus: rsvp.status, rsvpCount })
  } catch (error) {
    console.error("RSVP error:", error)
    return serverErrorResponse("Failed to update RSVP")
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> }
) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return unauthorizedResponse("Authentication required")

    const { eventId } = await params
    if (!uuidRegex.test(eventId)) return errorResponse("Invalid event ID format", 400)

    await db.event_rsvps.deleteMany({
      where: { event_id: eventId, user_id: user.userId },
    })

    const rsvpCount = await db.event_rsvps.count({
      where: { event_id: eventId, status: "going" },
    })

    return successResponse({ rsvpStatus: null, rsvpCount })
  } catch (error) {
    console.error("RSVP cancel error:", error)
    return serverErrorResponse("Failed to cancel RSVP")
  }
}
