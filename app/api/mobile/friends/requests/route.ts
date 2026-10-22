import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { participationRefusal, unfinishedResponse } from "@/lib/event-access"
import { INVITE_TOKEN, mayConnect, personCard, personSelect, requestFriend } from "@/lib/friends"
import { identityForRef } from "@/lib/identity"
import { recordReferral } from "@/lib/plus"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import {
  successResponse,
  unauthorizedResponse,
  validationErrorResponse,
  errorResponse,
  ErrorCode,
  serverErrorResponse,
} from "@/lib/api-response"
import { readJson } from "@/lib/api-input"
import { createdBefore, keysetPage, LIST_PAGE, NEWEST_FIRST, parseListQuery, type ListPagination } from "@/lib/pagination"

/**
 * GET /api/mobile/friends/requests — waiting for me, and waiting on others,
 * a page of each at a time.
 *
 * `incoming` leaves out what I answered "Not now". `outgoing` never says
 * whether the other person did: the asker keeps seeing "Requested", because a
 * decline that reaches them is a rejection.
 *
 * Both lists come back, newest first, `?limit=` of each (default 50, at most
 * 100), with `pagination.incoming` and `pagination.outgoing` (`hasMore`,
 * `nextCursor`, `totalCount`). To page one of them, ask for it alone:
 * `?list=incoming&cursor=…` answers only that array.
 */
export async function GET(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const me = authUser.userId

    const params = request.nextUrl.searchParams
    const list = params.get("list")
    if (list !== null && list !== "incoming" && list !== "outgoing") return errorResponse("Invalid list", 400)
    if (params.get("cursor") && !list) return errorResponse("A cursor needs ?list=incoming or ?list=outgoing", 400)
    const query = parseListQuery(params, LIST_PAGE.REQUESTS)
    if (query === "bad_cursor") return errorResponse("Invalid cursor", 400)
    const { limit, after } = query

    const incomingWhere = { recipient_id: me, dismissed_at: null, withdrawn_at: null, sender: { deletedAt: null } }
    const outgoingWhere = { sender_id: me, withdrawn_at: null, recipient: { deletedAt: null } }
    const cursorFor = (which: "incoming" | "outgoing") => (list === which && after ? createdBefore(after) : {})

    const [incoming, outgoing] = await Promise.all([
      list === "outgoing"
        ? null
        : Promise.all([
            db.friend_requests.count({ where: incomingWhere }),
            db.friend_requests.findMany({
              where: { ...incomingWhere, ...cursorFor("incoming") },
              select: { id: true, created_at: true, sender: { select: personSelect } },
              orderBy: NEWEST_FIRST,
              take: limit + 1,
            }),
          ]),
      list === "incoming"
        ? null
        : Promise.all([
            db.friend_requests.count({ where: outgoingWhere }),
            db.friend_requests.findMany({
              where: { ...outgoingWhere, ...cursorFor("outgoing") },
              select: { id: true, created_at: true, recipient: { select: personSelect } },
              orderBy: NEWEST_FIRST,
              take: limit + 1,
            }),
          ]),
    ])

    const paged = <T extends { id: string; created_at: Date }>(r: [number, T[]] | null) => {
      if (!r) return null
      const page = keysetPage(r[1], limit, (row) => ({ at: row.created_at, id: row.id }))
      return { ...page, pagination: { limit, hasMore: page.hasMore, nextCursor: page.nextCursor, totalCount: r[0] } satisfies ListPagination }
    }
    const inc = paged(incoming)
    const out = paged(outgoing)

    return successResponse({
      ...(inc && { incoming: inc.items.map((r) => ({ id: r.id, person: personCard(r.sender), createdAt: r.created_at })) }),
      ...(out && { outgoing: out.items.map((r) => ({ id: r.id, person: personCard(r.recipient), createdAt: r.created_at })) }),
      pagination: { ...(inc && { incoming: inc.pagination }), ...(out && { outgoing: out.pagination }) },
    })
  } catch (error) {
    logger.error("List friend requests error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to load friend requests")
  }
}

/*
 * Exactly one way in. A token is somebody's invite link; a user id is only
 * accepted for a person you can already see (a match, a conversation, someone
 * public in your room) — never an arbitrary id, or this would be a lookup.
 */
const createSchema = z.union([
  z.object({ token: z.string().regex(INVITE_TOKEN) }).strict(),
  // User ids are cuid, not uuid — do not tighten this to z.string().uuid().
  z.object({ userId: z.string().min(1) }).strict(),
])

/**
 * POST /api/mobile/friends/requests — ask to be friends.
 *
 * `{ state: "requested" }`, or `{ state: "friends" }` when they had already
 * asked you. Every way a stranger could be refused answers with the same 404.
 */
export async function POST(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const me = authUser.userId

    const limited = await rateLimit(request, userLimit("write", "friend-request", me))
    if (limited) return limited

    // Not onboarded and no adult age on file: may not take part yet (SCRUM-331).
    const unfinished = await participationRefusal(me)
    if (unfinished) return unfinishedResponse(unfinished)

    const parsed = createSchema.safeParse(await readJson(request))
    if (!parsed.success) return validationErrorResponse(parsed.error)

    // `errorCode` stays NOT_FOUND; the reason names what was asked for, never why it is out of reach.
    const gone = (reason: string) => errorResponse("Not found", 404, ErrorCode.NOT_FOUND, reason)
    let recipientId: string
    let connectable: boolean
    if ("token" in parsed.data) {
      const invite = await db.friend_invites.findUnique({
        where: { token: parsed.data.token },
        select: { user_id: true },
      })
      // Same work either way — see the invite route — so timing cannot tell a
      // reset link from a refusal.
      connectable = await mayConnect(me, invite?.user_id ?? me)
      if (!invite) return gone(ErrorCode.INVITE_UNAVAILABLE)
      recipientId = invite.user_id
    } else {
      // A room handle works here too (SCRUM-371); the identity gate refuses
      // anyone the room keeps a stranger — in that room's terms, so a reveal
      // at another event does not make this room's pseudonym askable.
      const target = await identityForRef(me, parsed.data.userId)
      recipientId = target.userId
      if (!target.identified) return gone(ErrorCode.PERSON_UNAVAILABLE)
      connectable = await mayConnect(me, recipientId)
    }

    if (recipientId === me) return errorResponse("You can't add yourself", 400, undefined, ErrorCode.CANNOT_ADD_SELF)
    if (!connectable) return gone("token" in parsed.data ? ErrorCode.INVITE_UNAVAILABLE : ErrorCode.PERSON_UNAVAILABLE)

    const state = await requestFriend(me, recipientId)
    // Their invite link brought me: the first link a person uses is the one
    // that counts toward its owner's Blendn+ referral month (lib/plus.ts).
    if ("token" in parsed.data) await recordReferral(me, recipientId)
    return successResponse({ state })
  } catch (error) {
    logger.error("Create friend request error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to send friend request")
  }
}
