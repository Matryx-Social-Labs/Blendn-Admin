import { NextRequest } from "next/server"

import { errorResponse, serverErrorResponse, successResponse } from "@/lib/api-response"
import { boardRefusal, lobbyPhase } from "@/lib/board"
import { outstandingAsk, liveRequest, VISIBLE_TO_AUTHOR } from "@/lib/board-access"
import { chatClosesAt } from "@/lib/chat-window"
import { blockCounterparties } from "@/lib/conversations"
import { db } from "@/lib/db"
import { hiddenAuthorsFor, hostPostFor, joinedThrough } from "@/lib/lobby"
import { lobbyDoor } from "@/lib/lobby-route"
import { logger } from "@/lib/logger"

interface RouteParams {
  params: Promise<{ eventId: string }>
}

/**
 * "From the Lobby", the card at the top of the room (SCRUM-1026, H-A): the
 * rides and groups you are in through the Lobby — an ask of yours accepted, or
 * one you accepted — each with its room when it has one; how many asks are
 * still waiting either way; the host's pinned post; and until when the Lobby
 * can be read. For anybody the Lobby reads for, and anybody checked in.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { eventId } = await params
    const door = await lobbyDoor(request, eventId, "none")
    if (door instanceof Response) return door
    const { userId, event, state, mayRead } = door
    if (!mayRead) {
      const checkedIn = await db.event_check_ins.findFirst({ where: { event_id: eventId, user_id: userId }, select: { id: true } })
      if (!checkedIn) {
        const { message, reasonCode } = boardRefusal("not_going", "read")
        return errorResponse(message, 403, undefined, reasonCode)
      }
    }

    const now = new Date()
    const [hidden, blocked] = await Promise.all([hiddenAuthorsFor(userId), blockCounterparties(userId)])
    const [joined, pinned, yours, waitingOnYou] = await Promise.all([
      joinedThrough(event, userId, hidden),
      hostPostFor(event),
      db.board_requests.count({ where: { event_id: eventId, from_user_id: userId, ...outstandingAsk(now, blocked) } }),
      db.board_requests.count({ where: { event_id: eventId, to_user_id: userId, ...VISIBLE_TO_AUTHOR, from_user_id: { notIn: blocked }, ...liveRequest(now) } }),
    ])
    const base = { state, phase: lobbyPhase(state), readUntil: chatClosesAt(event) }
    /*
     * Nothing to show is said, not drawn (owner, 2026-11-06): no post you are
     * in, no host note, no ask waiting, and the room shows no card at all. A
     * host note alone is content: the card is just the note.
     */
    const hasContent = joined.length > 0 || pinned !== null || yours + waitingOnYou > 0
    if (!hasContent) return successResponse({ ...base, hasContent: false })
    return successResponse({ ...base, hasContent: true, pinned, joined, asks: { yours, waitingOnYou } })
  } catch (error) {
    logger.error("Lobby summary error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to load the Lobby")
  }
}
