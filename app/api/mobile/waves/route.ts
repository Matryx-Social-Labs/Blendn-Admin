import { NextRequest } from "next/server"

import { serverErrorResponse, successResponse, unauthorizedResponse } from "@/lib/api-response"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { eventRoomBan } from "@/lib/room-kind"
import { operatesEvent } from "@/lib/tonight"
import { wavesWaiting } from "@/lib/waves"

/**
 * Banter's pinned rows (B-A, SCRUM-1042): one per open room where somebody's
 * wave is waiting for you, with how many and the newest, by room handle and
 * the roster's name, never an id. A room you run or host is never in it, and
 * a room that has closed has nothing left to answer. The room's own list is
 * `GET /events/:eventId/waves`.
 */
export async function GET(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")

    const limited = await rateLimit(request, userLimit("read", "waves-waiting", authUser.userId))
    if (limited) return limited

    const viewerId = authUser.userId
    // Shut to you: a room you run or host, or one whose host banned you (its list answers the same).
    const shut = async (eventId: string) => (await operatesEvent(viewerId, eventId)) || (await eventRoomBan(eventId, viewerId)) !== null
    const rooms = await wavesWaiting(viewerId, shut)
    return successResponse({ rooms })
  } catch (error) {
    logger.error("Waves waiting error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to load waves")
  }
}
