import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { z } from "zod"

import { boardDenialMessage, mayReadBoard } from "@/lib/board"
import { boardPseudonyms, boardWriteDenial, entitlementFor } from "@/lib/board-access"
import { BOARD } from "@/lib/constants"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import {
  successResponse,
  errorResponse,
  validationErrorResponse,
  unauthorizedResponse,
  forbiddenResponse,
  notFoundResponse,
  serverErrorResponse,
} from "@/lib/api-response"

interface RouteParams {
  params: Promise<{ eventId: string }>
}

/**
 * The pre-event board: going alone, and looking for somebody to go with.
 *
 * This is what gives `event_rsvps` a job. An RSVP has been a dead-end signal
 * that existed as a dashboard number; here it is the gate that makes intent
 * mean something.
 *
 * Pseudonymous, like the room. The board is read by people deciding whether to
 * travel somewhere with a stranger, and a name on it would be the one place in
 * the product where identity is handed over before anybody consented to it.
 */

// GET /api/mobile/events/[eventId]/board
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return unauthorizedResponse("Authentication required")

    const { eventId } = await params

    const event = await db.events.findUnique({
      where: { id: eventId, deleted_at: null },
      select: { id: true, start_time: true },
    })
    if (!event) return notFoundResponse("Event not found")

    const denial = mayReadBoard(await entitlementFor(eventId, user.userId))
    if (denial) return forbiddenResponse(boardDenialMessage(denial))

    /*
     * Live posts only, newest first, and the author as a pseudonym.
     *
     * `anonymous_name` comes from `chat_group_members`, the same handle the
     * room uses — so somebody who posts on the board and then talks in the room
     * is recognisably the same person to people at that event, and nobody
     * else. A second naming scheme would either break that continuity or
     * create a handle that follows them between events.
     */
    const posts = await db.board_posts.findMany({
      where: { event_id: eventId, deleted_at: null },
      orderBy: { created_at: "desc" },
      take: 100,
      select: {
        id: true,
        kind: true,
        body: true,
        spaces_left: true,
        created_at: true,
        author_id: true,
        _count: { select: { requests: true } },
      },
    })

    const pseudonymOf = await boardPseudonyms(
      eventId,
      posts.map((p) => p.author_id)
    )

    return successResponse({
      posts: posts.map((p) => ({
        id: p.id,
        kind: p.kind,
        body: p.body,
        spacesLeft: p.spaces_left,
        createdAt: p.created_at,
        author: pseudonymOf.get(p.author_id) ?? "Attendee",
        /** Yours, so the client can offer to withdraw rather than to answer. */
        mine: p.author_id === user.userId,
        /*
         * A count, never who. The same rule the room's reactions follow: how
         * many people have asked is useful, and naming them would disclose who
         * is looking for company to everybody browsing.
         */
        requestCount: p._count.requests,
      })),
    })
  } catch (error) {
    logger.error("Board read error", {
      error: error instanceof Error ? error.message : String(error),
    })
    return serverErrorResponse("Failed to load the board")
  }
}

const postSchema = z.object({
  kind: z.enum(["offer", "seeking", "chat"]),
  body: z.string().trim().min(1, "Say something").max(BOARD.MAX_POST_LENGTH),
  /** Only meaningful on an offer; the CHECK constraint enforces that too. */
  spacesLeft: z.number().int().min(0).max(20).optional(),
})

// POST /api/mobile/events/[eventId]/board
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return unauthorizedResponse("Authentication required")

    const limited = await rateLimit(request, userLimit("write", "board-post", user.userId))
    if (limited) return limited

    const { eventId } = await params

    const body = await request.json()
    const validation = postSchema.safeParse(body)
    if (!validation.success) return validationErrorResponse(validation.error)
    const input = validation.data

    if (input.spacesLeft !== undefined && input.kind !== "offer") {
      return errorResponse("Only an offer has spaces", 400)
    }

    /*
     * The board closes at doors.
     *
     * After that the live room is the place, and it is gated on presence
     * rather than intent. A board that stayed open would be a second room with
     * a weaker gate running beside the real one.
     */
    const event = await db.events.findUnique({
      where: { id: eventId, deleted_at: null },
      select: { id: true, start_time: true },
    })
    if (!event) return notFoundResponse("Event not found")
    if (event.start_time <= new Date()) {
      return errorResponse("The board closes when the doors open — the room is open instead", 403)
    }

    const denial = await boardWriteDenial(eventId, user.userId)
    if (denial) return forbiddenResponse(boardDenialMessage(denial))

    const created = await db.board_posts.create({
      data: {
        event_id: eventId,
        author_id: user.userId,
        kind: input.kind,
        body: input.body,
        ...(input.spacesLeft !== undefined && { spaces_left: input.spacesLeft }),
      },
      select: { id: true, kind: true, body: true, spaces_left: true, created_at: true },
    })

    return successResponse(
      {
        id: created.id,
        kind: created.kind,
        body: created.body,
        spacesLeft: created.spaces_left,
        createdAt: created.created_at,
      },
      201
    )
  } catch (error) {
    logger.error("Board post error", {
      error: error instanceof Error ? error.message : String(error),
    })
    return serverErrorResponse("Failed to post")
  }
}
