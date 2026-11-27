import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { eventAccessResponse, participationRefusal } from "@/lib/event-access"
import { INVITE_TOKEN, matchStanding, mayConnect, personCard, personSelect, releaseHeldRequests, requestFriend } from "@/lib/friends"
import { userIdFromDmRef } from "@/lib/conversation-ref"
import { identityForRef } from "@/lib/identity"
import { recordReferral } from "@/lib/plus"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit, withReasonCode } from "@/lib/rate-limit"
import {
  successResponse,
  unauthorizedResponse,
  validationErrorResponse,
  errorResponse,
  ErrorCode,
  serverErrorResponse,
} from "@/lib/api-response"
import { readJson } from "@/lib/api-input"
import { createdBefore, keysetPage, LEGACY_PAGE, LIST_PAGE, NEWEST_FIRST, parseListQuery, type ListPagination } from "@/lib/pagination"

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
 *
 * Each incoming row says where the ask came from: `via` is `"link"` (your invite
 * link) or `"match"` (a match you both revealed in), and null for a request made
 * before that was recorded. Outgoing rows carry none: you know how you asked.
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
    const query = parseListQuery(params, LIST_PAGE.REQUESTS, LEGACY_PAGE)
    if (query === "bad_cursor") return errorResponse("Invalid cursor", 400)
    const { limit, after } = query

    /*
     * A request held for a pseudonymous match is not delivered yet (`held_at`).
     * Whatever has become deliverable since — both revealed, the conversation open
     * — is released first (idempotent; one bounded read when nothing is held), so
     * the page, the count and the cursor below are exact without a per-row filter.
     */
    await releaseHeldRequests([me]).catch(() => undefined)
    const incomingWhere = { recipient_id: me, held_at: null, dismissed_at: null, withdrawn_at: null, sender: { deletedAt: null } }
    const outgoingWhere = { sender_id: me, withdrawn_at: null, recipient: { deletedAt: null } }
    const cursorFor = (which: "incoming" | "outgoing") => (list === which && after ? createdBefore(after) : {})

    const [incoming, outgoing] = await Promise.all([
      list === "outgoing"
        ? null
        : Promise.all([
            db.friend_requests.count({ where: incomingWhere }),
            db.friend_requests.findMany({
              where: { ...incomingWhere, ...cursorFor("incoming") },
              select: { id: true, created_at: true, via: true, sender: { select: personSelect } },
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
      // `via`: "link" or "match", null for a request from before the source was recorded (Flow 7 2-A, 4-A).
      ...(inc && { incoming: inc.items.map((r) => ({ id: r.id, person: personCard(r.sender), createdAt: r.created_at, via: viaOf(r.via) })) }),
      ...(out && { outgoing: out.items.map((r) => ({ id: r.id, person: personCard(r.recipient), createdAt: r.created_at })) }),
      pagination: { ...(inc && { incoming: inc.pagination }), ...(out && { outgoing: out.pagination }) },
    })
  } catch (error) {
    logger.error("List friend requests error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to load friend requests")
  }
}

const viaOf = (via: string | null): "link" | "match" | null => (via === "link" || via === "match" ? via : null)

/*
 * Exactly one way in. A token is somebody's invite link; a user id is only
 * accepted for a match where both of you have revealed (`revealedMatch`) —
 * never an arbitrary id, or this would be a lookup.
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
 * asked you. Every way a stranger could be refused answers with the same 404,
 * a match not swapped on both sides included: until both swap, neither may name
 * the other, so a reason would say who a pseudonym is (`NOT_A_REVEALED_MATCH`
 * was deleted with the swap, 2026-11-20).
 */
export async function POST(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const me = authUser.userId

    const limited = await rateLimit(request, userLimit("write", "friend-request", me))
    if (limited) return withReasonCode(limited, ErrorCode.RATE_LIMITED)

    // Known to be under 18, or not onboarded with no adult age on file: may not take part (SCRUM-331, SCRUM-1169).
    const unfinished = await participationRefusal(me)
    if (unfinished) return eventAccessResponse(unfinished)

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
      // The decision is the match (`revealedMatch`, lib/friends.ts). A room
      // handle still resolves through `identityForRef`, and a handle the room
      // keeps anonymous is refused as unknown even for a revealed match: a
      // 200 there would say which pseudonym in that room is them.
      // A conversation's handle -- what a match's or a board post's chat gives
      // for the other person, swapped or not -- names them to the other person
      // in that chat (`userIdFromDmRef`), and the match rule below decides: a
      // pair who have swapped may ask; anyone else gets the plain 404.
      const viaDm = await userIdFromDmRef(me, parsed.data.userId)
      const target = viaDm
        ? { userId: viaDm, room: null, identified: true }
        : await identityForRef(me, parsed.data.userId)
      recipientId = target.userId
      const { standing } = await matchStanding(me, recipientId)
      const nameable = !target.room || target.identified
      connectable = nameable && standing === "revealed"
    }

    if (recipientId === me) return errorResponse("You can’t add yourself", 400, undefined, ErrorCode.CANNOT_ADD_SELF)
    if (!connectable) return gone("token" in parsed.data ? ErrorCode.INVITE_UNAVAILABLE : ErrorCode.PERSON_UNAVAILABLE)

    const state = await requestFriend(me, recipientId, "token" in parsed.data ? "link" : "match")
    // An unmatch or a block landed between the check above and the pair's lock.
    if (state === "refused") return gone("token" in parsed.data ? ErrorCode.INVITE_UNAVAILABLE : ErrorCode.PERSON_UNAVAILABLE)
    // Their invite link brought me: the first link a person uses is the one
    // that counts toward its owner's Blendn+ referral month (lib/plus.ts).
    if ("token" in parsed.data) await recordReferral(me, recipientId)
    return successResponse({ state })
  } catch (error) {
    logger.error("Create friend request error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to send friend request")
  }
}
