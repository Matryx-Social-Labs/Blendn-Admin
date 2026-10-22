import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { participationRefusal, unfinishedResponse } from "@/lib/event-access"
import { INVITE_TOKEN, matchStanding, mayConnect, personCard, personSelect, requestFriend, withoutHeld } from "@/lib/friends"
import { identityForRef } from "@/lib/identity"
import { recordReferral } from "@/lib/plus"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit, withReasonCode } from "@/lib/rate-limit"
import {
  successResponse,
  unauthorizedResponse,
  validationErrorResponse,
  errorResponse,
  notFoundResponse,
  ErrorCode,
  serverErrorResponse,
} from "@/lib/api-response"
import { readJson } from "@/lib/api-input"

/**
 * GET /api/mobile/friends/requests — waiting for me, and waiting on others.
 *
 * `incoming` leaves out what I answered "Not now". `outgoing` never says
 * whether the other person did: the asker keeps seeing "Requested", because a
 * decline that reaches them is a rejection.
 */
export async function GET(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const me = authUser.userId

    const [incoming, outgoing] = await Promise.all([
      db.friend_requests.findMany({
        where: { recipient_id: me, dismissed_at: null, withdrawn_at: null, sender: { deletedAt: null } },
        select: { id: true, created_at: true, sender_id: true, recipient_id: true, held_at: true, sender: { select: personSelect } },
        orderBy: { created_at: "desc" },
      }),
      db.friend_requests.findMany({
        where: { sender_id: me, withdrawn_at: null, recipient: { deletedAt: null } },
        select: { id: true, created_at: true, recipient: { select: personSelect } },
        orderBy: { created_at: "desc" },
      }),
    ])

    // A request held for a pseudonymous match is not delivered yet.
    const visibleIncoming = await withoutHeld(incoming)

    return successResponse({
      incoming: visibleIncoming.map((r) => ({ id: r.id, person: personCard(r.sender), createdAt: r.created_at })),
      outgoing: outgoing.map((r) => ({ id: r.id, person: personCard(r.recipient), createdAt: r.created_at })),
    })
  } catch (error) {
    logger.error("List friend requests error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to load friend requests")
  }
}

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
 * asked you. Every way a stranger could be refused answers with the same 404.
 * The one addition: a 404 carries `reasonCode` `NOT_A_REVEALED_MATCH` when you
 * are in an open match with that person, THEY have revealed to you, and you have
 * not revealed back: you already know who they are, so it tells you nothing. For
 * a person still a pseudonym to you (and for a room handle that keeps them
 * anonymous) the 404 is plain — the code would say who the pseudonym is.
 */
export async function POST(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const me = authUser.userId

    const limited = await rateLimit(request, userLimit("write", "friend-request", me))
    if (limited) return withReasonCode(limited, ErrorCode.RATE_LIMITED)

    // Not onboarded and no adult age on file: may not take part yet (SCRUM-331).
    const unfinished = await participationRefusal(me)
    if (unfinished) return unfinishedResponse(unfinished)

    const parsed = createSchema.safeParse(await readJson(request))
    if (!parsed.success) return validationErrorResponse(parsed.error)

    const notFound = () => notFoundResponse("Not found")
    let recipientId: string
    let connectable: boolean
    let notYetRevealed = false
    if ("token" in parsed.data) {
      const invite = await db.friend_invites.findUnique({
        where: { token: parsed.data.token },
        select: { user_id: true },
      })
      // Same work either way — see the invite route — so timing cannot tell a
      // reset link from a refusal.
      connectable = await mayConnect(me, invite?.user_id ?? me)
      if (!invite) return notFound()
      recipientId = invite.user_id
    } else {
      // The decision is the match (`revealedMatch`, lib/friends.ts). A room
      // handle still resolves through `identityForRef`, and a handle the room
      // keeps anonymous is refused as unknown even for a revealed match: a
      // 200 there would say which pseudonym in that room is them.
      // A conversation's handle (what the inbox gives for a match until they
      // reveal) is not resolved here: it is only ever somebody the asker cannot
      // name yet, so the answer would be the plain 404 anyway, and it is, as an
      // id nobody has.
      const target = await identityForRef(me, parsed.data.userId)
      recipientId = target.userId
      const { standing, askerSeesThem } = await matchStanding(me, recipientId)
      const nameable = !target.room || target.identified
      connectable = nameable && standing === "revealed"
      // Only to somebody who can already name them, or the 404 says who a
      // pseudonym is: "Otter" asked by a friend's id, or by a handle from a
      // room where she is revealed, would come back "you matched her".
      notYetRevealed = nameable && standing === "pending" && askerSeesThem
    }

    if (recipientId === me) return errorResponse("You can't add yourself")
    if (notYetRevealed) return errorResponse("Not found", 404, undefined, "NOT_A_REVEALED_MATCH")
    if (!connectable) return notFound()

    const state = await requestFriend(me, recipientId, "token" in parsed.data ? undefined : "match")
    // An unmatch or a block landed between the check above and the pair's lock.
    if (state === "refused") return notFound()
    // Their invite link brought me: the first link a person uses is the one
    // that counts toward its owner's Blendn+ referral month (lib/plus.ts).
    if ("token" in parsed.data) await recordReferral(me, recipientId)
    return successResponse({ state })
  } catch (error) {
    logger.error("Create friend request error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to send friend request")
  }
}
