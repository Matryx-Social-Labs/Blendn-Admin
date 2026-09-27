import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { participationRefusal } from "@/lib/event-access"
import { INVITE_TOKEN, mayConnect, personCard, personSelect, requestFriend } from "@/lib/friends"
import { maySeeIdentity } from "@/lib/identity"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import {
  successResponse,
  unauthorizedResponse,
  validationErrorResponse,
  errorResponse,
  notFoundResponse,
  forbiddenResponse,
  serverErrorResponse,
} from "@/lib/api-response"

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
        select: { id: true, created_at: true, sender: { select: personSelect } },
        orderBy: { created_at: "desc" },
      }),
      db.friend_requests.findMany({
        where: { sender_id: me, withdrawn_at: null, recipient: { deletedAt: null } },
        select: { id: true, created_at: true, recipient: { select: personSelect } },
        orderBy: { created_at: "desc" },
      }),
    ])

    return successResponse({
      incoming: incoming.map((r) => ({ id: r.id, person: personCard(r.sender), createdAt: r.created_at })),
      outgoing: outgoing.map((r) => ({ id: r.id, person: personCard(r.recipient), createdAt: r.created_at })),
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
    if (unfinished) return forbiddenResponse(unfinished)

    const parsed = createSchema.safeParse(await request.json())
    if (!parsed.success) return validationErrorResponse(parsed.error)

    const notFound = () => notFoundResponse("Not found")
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
      if (!invite) return notFound()
      recipientId = invite.user_id
    } else {
      recipientId = parsed.data.userId
      if (recipientId !== me && !(await maySeeIdentity(me, recipientId))) return notFound()
      connectable = await mayConnect(me, recipientId)
    }

    if (recipientId === me) return errorResponse("You can't add yourself")
    if (!connectable) return notFound()

    return successResponse({ state: await requestFriend(me, recipientId) })
  } catch (error) {
    logger.error("Create friend request error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to send friend request")
  }
}
