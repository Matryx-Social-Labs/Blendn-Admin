import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { z } from "zod"

import { boardRefusal, lobbyPhase, lobbyState, lobbyStateRefusal, PHOTO_ALT_MAX, subKindFits, subKindsFor } from "@/lib/board"
import { boardWriteDenial, checkBoardText, hideBoardPostIfFlagged } from "@/lib/board-access"
import { chatClosesAt, doorsAt } from "@/lib/chat-window"
import { BOARD } from "@/lib/constants"
import { db } from "@/lib/db"
import { filteredWhere, hiddenAuthorsFor, hidesTickets, hostPostFor, livePostsWhere, lobbyCounts, lobbyEventSelect, matchRecipients, postSelect, shapePosts } from "@/lib/lobby"
import { moderateLobbyPhoto } from "@/lib/lobby-photo"
import { lobbyDoor } from "@/lib/lobby-route"
import { notifyLobbyMatch } from "@/lib/push-notifications"
import { discardSealedChatMedia, isOwnChatMedia, NOT_OWN_MEDIA, sealChatMedia } from "@/lib/validations/chat"
import { attendeeEventAccess, eventAccessResponse } from "@/lib/event-access"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import {
  successResponse,
  errorResponse,
  validationErrorResponse,
  unauthorizedResponse,
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

const listQuerySchema = z.object({
  kind: z.enum(["offer", "seeking", "chat"]).optional(),
  subKind: z.enum(["ride", "spots", "ticket", "buddy"]).optional(),
  /** "Mine", or "Replies to me" (`lib/lobby.ts`). */
  filter: z.enum(["mine", "replies"]).optional(),
})

// GET /api/mobile/events/[eventId]/board
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { eventId } = await params
    /*
     * Readable until the room closes (SCRUM-1026). It used to close for
     * reading at doors, and the plans people had made there (who is driving
     * whom) vanished at the moment they were needed. From doors it is
     * read-only, and a day after the end it closes with the room.
     */
    const door = await lobbyDoor(request, eventId)
    if (door instanceof Response) return door
    const { userId, event, state } = door

    const filters = listQuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams))
    if (!filters.success) return validationErrorResponse(filters.error)
    const filter = { kind: filters.data.kind, subKind: filters.data.subKind, mine: filters.data.filter === "mine", replies: filters.data.filter === "replies" }

    // Both directions, as the ask already is, and friends (the owner's rule): a friend must never meet a friend as a pseudonym.
    const hidden = await hiddenAuthorsFor(userId)

    /*
     * Live posts only, newest first, a page at a time (`?limit=` default 100, `?cursor=`), filtered on the server
     * (`?kind=`, `?subKind=`, `?filter=mine|replies`), and the author as a pseudonym — the room's handle, so somebody
     * who posts here and then talks in the room is recognisably the same person at that event and nowhere else.
     */
    const query = parseListQuery(request.nextUrl.searchParams, LIST_PAGE.PEOPLE)
    if (query === "bad_cursor") return errorResponse("Invalid cursor", 400)
    const { limit, after } = query

    const base = livePostsWhere(event, hidden)
    const where = filteredWhere(base, filter, userId)
    const [totalCount, rows] = await Promise.all([
      db.board_posts.count({ where }),
      db.board_posts.findMany({
        where: after ? { AND: [where, createdBefore(after)] } : where,
        orderBy: NEWEST_FIRST,
        take: limit + 1,
        select: postSelect(userId),
      }),
    ])
    const page = keysetPage(rows, limit, (p) => ({ at: p.created_at, id: p.id }))
    const posts = await shapePosts(eventId, page.items, userId)

    /*
     * The first page carries what the screen draws around the list: the
     * counts for the filter chips, the host's pinned post, whether you can post
     * (and if not, why — the composer's slot says it), and your own posts a
     * moderator or the automatic check took down (SV9). Later pages are posts.
     */
    const first = after === null
    const [counts, pinned, compose, takenDown] = first
      ? await Promise.all([lobbyCounts(base, userId), hostPostFor(event), composeFor(eventId, userId, state), takenDownFor(eventId, userId)])
      : [null, null, null, []]

    const ticketsHidden = hidesTickets(event)
    return successResponse({
      state,
      phase: lobbyPhase(state),
      doorsAt: doorsAt(event),
      closesAt: chatClosesAt(event),
      ticketsHidden,
      subKinds: subKindsFor(ticketsHidden),
      ...(first && { counts, pinned, compose }),
      takenDown,
      posts,
      pagination: { limit, hasMore: page.hasMore, nextCursor: page.nextCursor, totalCount } satisfies ListPagination,
    })
  } catch (error) {
    logger.error("Board read error", {
      error: error instanceof Error ? error.message : String(error),
    })
    return serverErrorResponse("Failed to load the Lobby")
  }
}

/** Whether the caller may post now, and if not the sentence and `reasonCode` the composer's slot shows. */
async function composeFor(eventId: string, userId: string, state: "open" | "read_only") {
  if (state !== "open") return { allowed: false, ...lobbyStateRefusal(state) }
  const denial = await boardWriteDenial(eventId, userId)
  return denial ? { allowed: false, ...boardRefusal(denial, "write") } : { allowed: true, message: null, reasonCode: null }
}

/**
 * Your own posts a moderator or the automatic check took down, so the app can
 * say so (SV9). Yours only, newest first, a few: the author is the one person
 * the Lobby tells, and a withdrawal by the author is not here.
 */
async function takenDownFor(eventId: string, userId: string) {
  const rows = await db.board_posts.findMany({
    where: { event_id: eventId, author_id: userId, deleted_at: { not: null }, moderation_status: { in: ["removed", "hidden"] } },
    orderBy: { deleted_at: "desc" },
    take: TAKEN_DOWN_SHOWN,
    select: { id: true, kind: true, body: true, created_at: true, deleted_at: true },
  })
  return rows.map((p) => ({ id: p.id, kind: p.kind, body: p.body, createdAt: p.created_at, takenDownAt: p.deleted_at }))
}

const photoSchema = z.object({
  /** The upload's `publicUrl` from `POST /uploads/presigned-url` (`folder: "chat"`): your own, on our bucket. */
  url: z.string().url().max(2048),
  /** What a screen reader says instead of "Photo". Optional. */
  alt: z.string().trim().max(PHOTO_ALT_MAX).optional(),
})

const postSchema = z.object({
  kind: z.enum(["offer", "seeking", "chat"]),
  /** What about: an offer of a `ride`, `spots` or a spare `ticket`; a search for a `ride`, somebody to go with (`buddy`) or a `ticket`. */
  subKind: z.enum(["ride", "spots", "ticket", "buddy"]).optional(),
  body: z.string().trim().min(1, "Say something").max(BOARD.MAX_POST_LENGTH),
  /** Only meaningful on an offer; the CHECK constraint enforces that too. */
  spacesLeft: z.number().int().min(0).max(20).optional(),
  /** One photo per post. */
  photo: photoSchema.optional(),
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
      return errorResponse("Only an offer has spots", 400)
    }
    if (input.subKind && !subKindFits(input.kind, input.subKind)) {
      return errorResponse("That type doesn’t go with that post", 400)
    }
    if (input.photo && !isOwnChatMedia(input.photo.url, user.userId)) return errorResponse(NOT_OWN_MEDIA, 400)

    /*
     * Posting ends at doors (SCRUM-1026): from then the Lobby is read-only and
     * the room is the place, gated on presence rather than intent. A Lobby that
     * stayed writable would be a second room with a weaker gate beside it.
     */
    const denied = await attendeeEventAccess(user.userId, eventId, "participate")
    if (denied) return eventAccessResponse(denied)
    const event = await db.events.findUnique({ where: { id: eventId, deleted_at: null }, select: lobbyEventSelect })
    if (!event) return notFoundResponse("Event not found")
    const state = lobbyState(event)
    if (state !== "open") {
      const { message, reasonCode } = lobbyStateRefusal(state)
      return errorResponse(message, 403, undefined, reasonCode)
    }
    // A ticket sold here cannot be passed on yet, so the Lobby does not carry one (owner decision 5).
    if (input.subKind === "ticket" && hidesTickets(event)) {
      return errorResponse("Tickets for this event are sold on Blend’n and can’t be passed on in the Lobby yet", 422, undefined, "LOBBY_TICKETS_HIDDEN")
    }

    const denial = await boardWriteDenial(eventId, user.userId)
    if (denial) {
      const { message, reasonCode } = boardRefusal(denial, "write")
      return errorResponse(message, 403, undefined, reasonCode)
    }

    // Checked before it is stored, as a room message is (SCRUM-301).
    const verdict = await checkBoardText(input.body)
    if (verdict.refusal) return errorResponse(verdict.refusal, 422)

    // The server's own copy, with its location stripped; others see it once moderation approves it.
    const sealed = input.photo ? await sealChatMedia(input.photo.url, user.userId) : null
    if (sealed && "refusal" in sealed) return errorResponse(sealed.refusal, 422)

    let created
    try {
      created = await db.board_posts.create({
        data: {
          event_id: eventId,
          author_id: user.userId,
          kind: input.kind,
          ...(input.subKind && { sub_kind: input.subKind }),
          body: input.body,
          // A spare ticket is one ticket: "1 left" unless they say otherwise.
          ...(input.spacesLeft !== undefined
            ? { spaces_left: input.spacesLeft }
            : input.kind === "offer" && input.subKind === "ticket" && { spaces_left: 1 }),
          ...(sealed && { photo_url: sealed.url, photo_status: "pending" as const, ...(input.photo?.alt && { photo_alt: input.photo.alt }) }),
        },
        select: postSelect(user.userId),
      })
    } catch (error) {
      await discardSealedChatMedia(sealed)
      throw error
    }

    // OpenAI ran out of time: look again without the bound, as the room does.
    if (verdict.unchecked) {
      void hideBoardPostIfFlagged(created.id, created.body).catch((error) =>
        logger.error("Board post recheck failed", {
          postId: created.id,
          error: error instanceof Error ? error.message : String(error),
        })
      )
    }
    // The photo's own check, after the response; the sweep retries one that does not land.
    if (sealed) void moderateLobbyPhoto(created.id)
    // "Someone offers what you're looking for", to the people who asked to hear it.
    if (created.kind === "offer" && created.sub_kind && created.sub_kind !== "buddy") {
      const subKind = created.sub_kind
      void matchRecipients({ event_id: eventId, author_id: user.userId, sub_kind: subKind })
        .then((ids) => notifyLobbyMatch(ids, event, created.id, subKind))
        .catch((error) => logger.warn("Lobby match push failed", { postId: created.id, error: String(error) }))
    }

    const [shaped] = await shapePosts(eventId, [created], user.userId)
    return successResponse(shaped, 201)
  } catch (error) {
    logger.error("Board post error", {
      error: error instanceof Error ? error.message : String(error),
    })
    return serverErrorResponse("Failed to post")
  }
}
