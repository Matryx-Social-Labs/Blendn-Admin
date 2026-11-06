import { NextRequest } from "next/server"

import { serverErrorResponse, successResponse } from "@/lib/api-response"
import { lobbyPhase } from "@/lib/board"
import { chatClosesAt, doorsAt } from "@/lib/chat-window"
import { db } from "@/lib/db"
import { hiddenAuthorsFor, livePostsWhere, lobbyCounts, postSelect, shapePosts } from "@/lib/lobby"
import { lobbyDoor } from "@/lib/lobby-route"
import { logger } from "@/lib/logger"
import { NEWEST_FIRST } from "@/lib/pagination"

interface RouteParams {
  params: Promise<{ eventId: string }>
}

/** The preview's posts: the event page shows two. */
const PREVIEW_POSTS = 2

/**
 * The event page's Lobby card (SCRUM-1026): the counts, and the latest two
 * posts. Somebody who has neither saved the event nor said they are going gets
 * the counts only (`canRead: false`) — "Save it or say you're going to read the
 * Lobby" — and never a post. A photo in the preview is an approved one, or
 * your own (`photoFor`). Compact formatting (1.2k) is the client's.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { eventId } = await params
    const door = await lobbyDoor(request, eventId, "none")
    if (door instanceof Response) return door
    const { userId, event, state, mayRead } = door

    const base = livePostsWhere(event, await hiddenAuthorsFor(userId))
    const [counts, rows] = await Promise.all([
      lobbyCounts(base, userId),
      mayRead ? db.board_posts.findMany({ where: base, orderBy: NEWEST_FIRST, take: PREVIEW_POSTS, select: postSelect(userId) }) : [],
    ])
    return successResponse({
      state,
      phase: lobbyPhase(state),
      canRead: mayRead,
      doorsAt: doorsAt(event),
      closesAt: chatClosesAt(event),
      counts: { all: counts.all, offer: counts.offer, seeking: counts.seeking, chat: counts.chat, offerRides: counts.offerRides },
      latest: await shapePosts(eventId, rows, userId),
    })
  } catch (error) {
    logger.error("Lobby preview error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to load the Lobby")
  }
}
