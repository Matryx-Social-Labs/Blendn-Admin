import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { z } from "zod"

import { BOARD_CLOSED, boardDenialMessage, mayReadBoard } from "@/lib/board"
import { boardPseudonyms, boardWriteDenial, checkBoardText, entitlementFor, hideBoardPostIfFlagged, visibleBoardRequests } from "@/lib/board-access"
import { BOARD } from "@/lib/constants"
import { blockCounterparties } from "@/lib/conversations"
import { notStrangersTo } from "@/lib/room-people"
import { db } from "@/lib/db"
import { attendeeEventAccess, eventAccessResponse } from "@/lib/event-access"
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
import { readJson, isUuid } from "@/lib/api-input"
import { createdBefore, keysetPage, LIST_PAGE, NEWEST_FIRST, parseListQuery, type ListPagination } from "@/lib/pagination"

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

/** How many of an author's own taken-down posts the board read lists. */
const TAKEN_DOWN_SHOWN = 20

// GET /api/mobile/events/[eventId]/board
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return unauthorizedResponse("Authentication required")

    const { eventId } = await params
    if (!isUuid(eventId)) return errorResponse("Invalid event ID format", 400)

    const denied = await attendeeEventAccess(user.userId, eventId, "participate")
    if (denied) return eventAccessResponse(denied)
    const event = await db.events.findUnique({
      where: { id: eventId, deleted_at: null },
      select: { id: true, start_time: true },
    })
    if (!event) return notFoundResponse("Event not found")
    // Closed for reading too, on the same clock the writes use. A board still
    // readable after doors is a list of who came alone, open during the night.
    if (event.start_time <= new Date()) return errorResponse(BOARD_CLOSED, 403)

    const denial = mayReadBoard(await entitlementFor(eventId, user.userId))
    if (denial) return forbiddenResponse(boardDenialMessage(denial))

    // Both directions, as the ask already is: somebody who blocked you, or whom
    // you blocked, is not on your board.
    // And friends (the owner's rule): a board author is a pseudonym, and a friend must never meet a friend as one.
    const blocked = [...(await blockCounterparties(user.userId)), ...(await notStrangersTo(user.userId))]

    /*
     * Live posts only, newest first, a page at a time (`?limit=` default 100, `?cursor=`), and the author as a pseudonym.
     *
     * `anonymous_name` comes from `chat_group_members`, the same handle the
     * room uses — so somebody who posts on the board and then talks in the room
     * is recognisably the same person to people at that event, and nobody
     * else. A second naming scheme would either break that continuity or
     * create a handle that follows them between events.
     */
    const query = parseListQuery(request.nextUrl.searchParams, LIST_PAGE.PEOPLE)
    if (query === "bad_cursor") return errorResponse("Invalid cursor", 400)
    const { limit, after } = query

    const live = { event_id: eventId, deleted_at: null, author_id: { notIn: blocked } }
    const [totalCount, rows] = await Promise.all([
      db.board_posts.count({ where: live }),
      db.board_posts.findMany({
      where: after ? { AND: [live, createdBefore(after)] } : live,
      orderBy: NEWEST_FIRST,
      take: limit + 1,
      select: {
        id: true,
        kind: true,
        body: true,
        spaces_left: true,
        created_at: true,
        author_id: true,
        // Not the silenced ones, except your own: see `visibleBoardRequests`.
        _count: { select: { requests: { where: visibleBoardRequests(user.userId) } } },
      },
    }),
    ])
    const page = keysetPage(rows, limit, (p) => ({ at: p.created_at, id: p.id }))
    const posts = page.items

    const pseudonymOf = await boardPseudonyms(
      eventId,
      posts.map((p) => p.author_id)
    )

    /*
     * Your own posts a moderator or the automatic check took down, so the app
     * can say so (SV9). Yours only, newest first, a few: the author is the one
     * person the board tells, and a withdrawal by the author is not here.
     */
    const takenDown = after ? [] : await db.board_posts.findMany({
      where: { event_id: eventId, author_id: user.userId, deleted_at: { not: null }, moderation_status: { in: ["removed", "hidden"] } },
      orderBy: { deleted_at: "desc" },
      take: TAKEN_DOWN_SHOWN,
      select: { id: true, kind: true, body: true, created_at: true, deleted_at: true },
    })

    return successResponse({
      takenDown: takenDown.map((p) => ({
        id: p.id,
        kind: p.kind,
        body: p.body,
        createdAt: p.created_at,
        takenDownAt: p.deleted_at,
      })),
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
      pagination: { limit, hasMore: page.hasMore, nextCursor: page.nextCursor, totalCount } satisfies ListPagination,
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
    if (!isUuid(eventId)) return errorResponse("Invalid event ID format", 400)

    const body = await readJson(request)
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
    const denied = await attendeeEventAccess(user.userId, eventId, "participate")
    if (denied) return eventAccessResponse(denied)
    const event = await db.events.findUnique({
      where: { id: eventId, deleted_at: null },
      select: { id: true, start_time: true },
    })
    if (!event) return notFoundResponse("Event not found")
    if (event.start_time <= new Date()) return errorResponse(BOARD_CLOSED, 403)

    const denial = await boardWriteDenial(eventId, user.userId)
    if (denial) return forbiddenResponse(boardDenialMessage(denial))

    // Checked before it is stored, as a room message is (SCRUM-301).
    const verdict = await checkBoardText(input.body)
    if (verdict.refusal) return errorResponse(verdict.refusal, 422)

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

    // OpenAI ran out of time: look again without the bound, as the room does.
    if (verdict.unchecked) {
      void hideBoardPostIfFlagged(created.id, created.body).catch((error) =>
        logger.error("Board post recheck failed", {
          postId: created.id,
          error: error instanceof Error ? error.message : String(error),
        })
      )
    }

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
