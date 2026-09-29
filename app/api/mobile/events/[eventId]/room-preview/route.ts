import { NextRequest } from "next/server"

import { serverErrorResponse, successResponse, unauthorizedResponse, errorResponse } from "@/lib/api-response"
import { attendeeEventAccess, eventAccessResponse } from "@/lib/event-access"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { roomPreview } from "@/lib/room-preview"
import { isUuid } from "@/lib/api-input"

interface RouteParams {
  params: Promise<{ eventId: string }>
}

/**
 * The Room, seen from the door: `{ hereCount, tasteMatchCount }`.
 *
 * Open to anyone who can open the event — the same `attendeeEventAccess(view)`
 * gate as `GET /events/:id`, so a draft or a stranger's private event is a 404
 * here too, not a way to learn it exists. No check-in required: this is what
 * persuades somebody to walk in, and it carries only aggregates. The floor in
 * `lib/room-preview.ts` is what keeps an aggregate from naming anyone.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { eventId } = await params
    if (!isUuid(eventId)) return errorResponse("Invalid event ID format", 400)

    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")

    const denied = await attendeeEventAccess(authUser.userId, eventId, "view")
    if (denied) return eventAccessResponse(denied)

    return successResponse(await roomPreview(eventId, authUser.userId))
  } catch (error) {
    logger.error("Room preview error", {
      error: error instanceof Error ? error.message : String(error),
    })
    return serverErrorResponse("Failed to load the room")
  }
}
