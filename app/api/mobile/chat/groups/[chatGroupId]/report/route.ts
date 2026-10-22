import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { roomForMember } from "@/lib/room-membership"
import {
  successResponse,
  validationErrorResponse,
  unauthorizedResponse,
  notFoundResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { readJson } from "@/lib/api-input"

interface RouteParams {
  params: Promise<{ chatGroupId: string }>
}

/** The same body as every other report: a reason, and optionally what happened. */
const reportRoomSchema = z.object({
  reason: z.string().trim().min(1, "Reason is required").max(200),
  description: z.string().max(2000).optional(),
})

/**
 * POST /api/mobile/chat/groups/:chatGroupId/report — report a whole room.
 *
 * For what no single message shows: a pile-on, a room that has turned hostile,
 * a host letting it happen. A person could report a message, a person and the
 * event; the room in between had no path.
 *
 * Stored in `event_reports` with `chat_group_id` set, because a room is
 * one-to-one with its event and the reports queue already reads that table —
 * it shows these as "Room". Delisting the event is not offered on them: a bad
 * room is not a bad listing.
 *
 * **Members only**, any status. You have to have been in a room to report it —
 * the room is pseudonymous and invisible from outside — but somebody who left
 * it, or was banned from it, is exactly who may need to. Every other caller gets
 * the room's one 404, so this cannot be used to probe which rooms exist.
 * A room whose event has since been taken down is still reportable, as the
 * event report route allows: that is the evidence worth keeping.
 *
 * Repeat reports are allowed; the rate limit bounds abuse (see the event report).
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Authentication required")

    const limited = await rateLimit(request, userLimit("safety", "report-room", authUser.userId))
    if (limited) return limited

    const validation = reportRoomSchema.safeParse(await readJson(request))
    if (!validation.success) return validationErrorResponse(validation.error)

    const { chatGroupId } = await params
    const room = await roomForMember(chatGroupId, authUser.userId, { allowHidden: true })
    if (!room) return notFoundResponse("Chat group not found")
    // A room report is filed against the room's event (`event_reports`), and
    // only an event's room has one. In a room of any other kind each message is
    // reported on its own (`POST /messages/:id/report`), which every room takes.
    if (room.group.kind !== "event" || !room.group.event_id) return notFoundResponse("Chat group not found")

    await db.event_reports.create({
      data: {
        event_id: room.group.event_id,
        chat_group_id: room.group.id,
        user_id: authUser.userId,
        reason: validation.data.reason,
        // strictUndefinedChecks refuses an explicit undefined (SCRUM-106).
        ...(validation.data.description !== undefined && { description: validation.data.description }),
      },
    })

    return successResponse({ reported: true }, 201)
  } catch (error) {
    logger.error("Report room error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to submit report")
  }
}
