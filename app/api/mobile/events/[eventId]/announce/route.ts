import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { emitChatMessage } from "@/lib/socket-server"
import {
  successResponse,
  errorResponse,
  unauthorizedResponse,
  forbiddenResponse,
  notFoundResponse,
  serverErrorResponse,
} from "@/lib/api-response"

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ eventId: string }> }
) {
  try {
    const { eventId } = await params

    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Authentication required")
    }

    // Validate eventId is a valid UUID
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (!uuidRegex.test(eventId)) {
      return errorResponse("Invalid event ID format", 400)
    }

    // Fetch event to verify ownership and get chat group
    const event = await db.events.findUnique({
      where: { id: eventId, deleted_at: null },
      select: {
        id: true,
        organizer_id: true,
        chat_group: {
          select: { id: true },
        },
      },
    })

    if (!event) {
      return notFoundResponse("Event not found")
    }

    if (event.organizer_id !== authUser.userId) {
      return forbiddenResponse("You are not the organizer of this event")
    }

    const body = await request.json()
    const { content } = body as { content?: string }

    if (!content || typeof content !== "string" || content.trim().length === 0) {
      return errorResponse("Announcement content is required", 400)
    }

    if (content.trim().length > 1000) {
      return errorResponse("Announcement content must be 1000 characters or fewer", 400)
    }

    // Fetch organizer user info for socket emission
    const organizer = await db.user.findUnique({
      where: { id: authUser.userId },
      select: { id: true, name: true, image: true },
    })

    // Create announcement record
    const announcement = await db.event_announcements.create({
      data: {
        event_id: eventId,
        content: content.trim(),
        sent_by: authUser.userId,
      },
    })

    // Emit announcement to event chat group via socket if one exists
    if (event.chat_group?.id) {
      emitChatMessage(event.chat_group.id, {
        id: announcement.id,
        content: content.trim(),
        type: "announcement",
        userId: authUser.userId,
        userName: organizer?.name ?? "Organizer",
        userImage: organizer?.image ?? undefined,
        createdAt: announcement.created_at.toISOString(),
      })
    }

    return successResponse({ id: announcement.id })
  } catch (error) {
    console.error("Send announcement error:", error)
    return serverErrorResponse("Failed to send announcement")
  }
}
