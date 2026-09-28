import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { roomForMember } from "@/lib/room-membership"
import { roomMuteState, withMute, withoutMute } from "@/lib/room-mute"
import {
  successResponse,
  unauthorizedResponse,
  notFoundResponse,
  validationErrorResponse,
  errorResponse,
  serverErrorResponse,
  ErrorCode,
} from "@/lib/api-response"

interface RouteParams {
  params: Promise<{ chatGroupId: string }>
}

/** A year: long enough for "for good", short enough that a typo is not for ever. */
const MAX_MUTE_MS = 366 * 24 * 60 * 60 * 1000

const muteSchema = z.object({
  /** When the mute lapses. Omit or null for "until I turn it back on". */
  until: z.string().datetime({ offset: true }).nullable().optional(),
})

const notFound = () => notFoundResponse("Chat group not found")

/**
 * POST /api/mobile/chat/groups/:chatGroupId/mute — stop this room ringing.
 *
 * Silences the room's pushes to you (a reply to you, an announcement) and
 * nothing else: you still read and post, and nobody in the room is told. Not
 * the organiser's mute, which stops a person writing — see `lib/room-mute.ts`.
 *
 * Idempotent; posting again replaces `until`. Any member may mute, including a
 * banned one or one who left — it only ever removes noise.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")

    const limited = await rateLimit(request, userLimit("write", "room-mute", authUser.userId))
    if (limited) return limited

    // An empty body is the common call ("mute"), so a missing body is `{}`.
    const raw = await request.text()
    let body: unknown = {}
    if (raw.trim()) {
      try {
        body = JSON.parse(raw)
      } catch {
        return errorResponse("Invalid JSON body", 400, ErrorCode.VALIDATION_FAILED)
      }
    }
    const parsed = muteSchema.safeParse(body)
    if (!parsed.success) return validationErrorResponse(parsed.error)

    const now = new Date()
    const until = parsed.data.until ? new Date(parsed.data.until) : null
    if (until && until.getTime() <= now.getTime()) {
      return errorResponse("`until` must be in the future", 400, ErrorCode.VALIDATION_FAILED)
    }
    if (until && until.getTime() - now.getTime() > MAX_MUTE_MS) {
      return errorResponse("`until` can be at most a year away; omit it to mute until you unmute", 400, ErrorCode.VALIDATION_FAILED)
    }

    const { chatGroupId } = await params
    const room = await roomForMember(chatGroupId, authUser.userId)
    if (!room) return notFound()

    const prefs = withMute(room.membership.notification_preferences, until)
    await db.chat_group_members.update({
      where: { id: room.membership.id },
      data: { notification_preferences: prefs, updated_at: now },
    })

    return successResponse({ chatGroupId: room.group.id, mute: roomMuteState(prefs, now) })
  } catch (error) {
    logger.error("Mute room error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to mute the room")
  }
}

/**
 * DELETE /api/mobile/chat/groups/:chatGroupId/mute — let the room ring again.
 * Idempotent: unmuting a room that is not muted answers the same 200.
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")

    const limited = await rateLimit(request, userLimit("write", "room-mute", authUser.userId))
    if (limited) return limited

    const { chatGroupId } = await params
    const room = await roomForMember(chatGroupId, authUser.userId)
    if (!room) return notFound()

    const prefs = withoutMute(room.membership.notification_preferences)
    await db.chat_group_members.update({
      where: { id: room.membership.id },
      data: { notification_preferences: prefs, updated_at: new Date() },
    })

    return successResponse({ chatGroupId: room.group.id, mute: roomMuteState(prefs) })
  } catch (error) {
    logger.error("Unmute room error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to unmute the room")
  }
}
