import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { z } from "zod"
import { randomUUID } from "crypto"
import { haveSharedAnEvent, pairIsClosed } from "@/lib/conversations"
import { identityForRef } from "@/lib/identity"
import { userIdFromRef } from "@/lib/room-handle"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { participationRefusal } from "@/lib/event-access"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { sendPushNotification } from "@/lib/push-notifications"
import {
  successResponse,
  unauthorizedResponse,
  validationErrorResponse,
  errorResponse,
  notFoundResponse,
  conflictResponse,
  serverErrorResponse,
  forbiddenResponse,
} from "@/lib/api-response"

const createRequestSchema = z.object({
  // User ids are cuid, not uuid — do not tighten this to z.string().uuid().
  recipientId: z.string().min(1),
  /*
   * Required, not optional.
   *
   * A request with no message is indistinguishable from a like with a reveal
   * stapled to it -- and the two are now separate actions with separate
   * meanings. A like says "I would talk to you", privately and symmetrically. A
   * request says "here is who I am and why", which is worth the asymmetry only
   * if the "why" is actually there.
   *
   * It also makes the recipient's decision possible. "Someone wants to connect"
   * is a coin flip; "we both work in design and I liked your take on X" is
   * something you can answer.
   *
   * Trimmed before the length check, so whitespace is not a message.
   */
  message: z.string().trim().min(1).max(500),
})

// POST: Create a message request
export async function POST(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    const limited = await rateLimit(request, userLimit("write", "message-request", authUser.userId))
    if (limited) return limited

    // Not onboarded and no adult age on file: may not take part yet (SCRUM-331).
    const unfinished = await participationRefusal(authUser.userId)
    if (unfinished) return forbiddenResponse(unfinished)

    const body = await request.json()
    const parsed = createRequestSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }

    // A room handle or a raw id (SCRUM-371). `ref` is what the response
    // echoes, so a handle never comes back as the real id behind it.
    const { recipientId: ref, message } = parsed.data
    const recipientId = userIdFromRef(ref)

    // Cannot send request to yourself
    if (recipientId === authUser.userId) {
      return errorResponse("Cannot send a message request to yourself")
    }

    // Check if recipient exists
    const recipient = await db.user.findUnique({
      where: { id: recipientId },
      select: { id: true, name: true },
    })

    if (!recipient) {
      return notFoundResponse("User not found")
    }

    // Check if either user has blocked the other
    const blockExists = await db.blocked_users.findFirst({
      where: {
        OR: [
          { blocker_id: authUser.userId, blocked_id: recipientId },
          { blocker_id: recipientId, blocked_id: authUser.userId },
        ],
      },
      select: { blocker_id: true },
    })

    if (blockExists) {
      // Return generic not-found to avoid leaking block status to the sender
      return notFoundResponse("User not found")
    }

    /*
     * Leaving is permanent, and the same words as the likes route.
     *
     * A pair whose conversation was closed used to fall through to the
     * duplicate-request guard, which answered with whatever the old row said:
     * "This user has already sent you a request. Check your incoming requests"
     * -- to someone whose inbox is empty, about a request that was accepted,
     * talked through and ended. That tells the caller the other person once
     * wanted to talk and then stopped, which is a rejection notice by another
     * name. Driven 2026-09-13 on two phones after an unmatch.
     */
    if (await pairIsClosed(authUser.userId, recipientId)) {
      return notFoundResponse("User not found")
    }

    /*
     * You have to have been in the room.
     *
     * There was no such check: any authenticated caller could send a request to
     * any user id they could guess or scrape, which turns the product from "talk
     * to people you met" into a directory of strangers — and makes every other
     * privacy measure here decorative.
     *
     * "Ever", not "right now", deliberately. See `haveSharedAnEvent`.
     */
    if (!(await haveSharedAnEvent(authUser.userId, recipientId))) {
      return errorResponse("You can only message people from an event you have both attended")
    }

    // Check if a request already exists between these users (in either direction)
    const existingRequest = await db.message_requests.findFirst({
      where: {
        OR: [
          { sender_id: authUser.userId, recipient_id: recipientId },
          { sender_id: recipientId, recipient_id: authUser.userId },
        ],
      },
    })

    /*
     * A declined request is not a lock on the person who declined it.
     *
     * The check ignored `status`, so one declined request froze the pair in
     * both directions for good: the sender got "already sent" (right — a
     * rejection is not an invitation to try again, SCRUM-113) and the person
     * who declined got "this user has already sent you a request, check your
     * incoming requests" — about a request that no longer appears there. She
     * had changed her mind and could not say so (SCRUM-182).
     *
     * So: a pending or accepted request in either direction still blocks; a
     * declined one blocks only its sender.
     */
    // Check if a conversation already exists between these users
    const existingConversation = await db.private_conversations.findFirst({
      where: {
        OR: [
          { user1_id: authUser.userId, user2_id: recipientId },
          { user1_id: recipientId, user2_id: authUser.userId },
        ],
      },
    })

    const conflict = !existingRequest
      ? null
      : existingRequest.sender_id === authUser.userId
        ? "You have already sent a request to this user"
        : existingRequest.status !== "declined"
          ? "This user has already sent you a request. Check your incoming requests."
          : null
    const refusal = conflict ?? (existingConversation ? "You already have a conversation with this user" : null)

    if (refusal) {
      /*
       * Say so only to somebody who may already see who this is (SCRUM-371).
       *
       * Each of these 409s is a fact about the pair, and a room handle hides
       * the pair. A friend DM is the sharp case: it deliberately does not make
       * two friends recognisable in a room (`origin_friendship`), yet it
       * answered 409 here — so a friend could send a request to every card on a
       * roster and the one that refused was the friend. An earlier request does
       * the same across events, pinning two handles on one person.
       *
       * So for anyone the room keeps a stranger, "something already exists"
       * reads as a request just made: the same 201 and the same shape, with a
       * fresh random id — not the existing request's id, which the sender may
       * have from before and would recognise, and not one derived from the
       * pair, which a second ask by raw id would reproduce. Nothing is written
       * and nobody is notified: a second request to someone already asked, or
       * one to a friend already in a DM, is not something to deliver.
       *
       * The trade-off: the id is not a row. The respond route answers "not
       * found" for any request that is not yours to answer, so the sender
       * cannot ask it which ids are real; the client is not told either way,
       * which is the point. Someone who can see who this is still gets the
       * 409 — they know the answer already, and `GET /users/:id` hands the app
       * the same facts as `connection`.
       */
      // In the terms of the room the ref came from: a reveal, like or DM
      // elsewhere does not make this room's pseudonym someone you know.
      if ((await identityForRef(authUser.userId, ref)).identified) return conflictResponse(refusal)
      return successResponse(
        {
          request: {
            id: randomUUID(),
            recipientId: ref,
            recipient: { id: ref },
            message,
            status: "pending",
            createdAt: new Date(),
          },
        },
        201
      )
    }

    // Fetch sender name for push notification (authUser doesn't carry name)
    const sender = await db.user.findUnique({
      where: { id: authUser.userId },
      select: { name: true },
    })
    const senderName = sender?.name || "Someone"

    // Create the message request
    const messageRequest = await db.message_requests.create({
      data: {
        sender_id: authUser.userId,
        recipient_id: recipientId,
        message,
        status: "pending",
      },
      include: {
        recipient: { select: { id: true } },
      },
    })

    // Notify recipient of new message request (async, don't await)
    sendPushNotification({
      userId: recipientId,
      title: "New message request",
      // Deliberately generic: push bodies render on a locked screen, so the
      // request text stays in the app rather than on the lock screen.
      body: `${senderName} wants to connect`,
      data: { type: "message_request", requestId: messageRequest.id },
    }).catch((err: unknown) =>
      // Push is best-effort and must not fail the request, but swallowing the
      // error entirely means a broken push pipeline is invisible.
      logger.warn("Push notification failed", {
        context: "message request",
        error: err instanceof Error ? err.message : String(err),
      })
    )

    return successResponse(
      {
        request: {
          id: messageRequest.id,
          // The ref as given: a handle in, the same handle out (SCRUM-371).
          recipientId: ref,
          /*
           * The id only. This carried the recipient's real name and photo back
           * to the sender at the moment of asking — before she had done
           * anything. The request is the crossing from pseudonym to real name,
           * and accepting is what completes it (see the decline route: "the
           * decliner is never named"). A stranger picked off a pseudonymous
           * grid should not learn who she is from the act of asking (SCRUM-182).
           */
          recipient: { id: ref },
          message: messageRequest.message,
          status: messageRequest.status,
          createdAt: messageRequest.created_at,
        },
      },
      201
    )
  } catch (error) {
    logger.error("Create message request error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to create message request")
  }
}

// GET: List incoming message requests
export async function GET(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    const searchParams = request.nextUrl.searchParams
    const status = searchParams.get("status") || "pending"
    const limit = Math.min(parseInt(searchParams.get("limit") || "20"), 50)
    const offset = parseInt(searchParams.get("offset") || "0")

    // Validate status
    const validStatuses = ["pending", "accepted", "declined", "blocked"]
    if (!validStatuses.includes(status)) {
      return errorResponse("Invalid status filter")
    }

    // Get total count
    const totalCount = await db.message_requests.count({
      where: {
        recipient_id: authUser.userId,
        status: status as "pending" | "accepted" | "declined" | "blocked",
      },
    })

    // Fetch incoming message requests
    const requests = await db.message_requests.findMany({
      where: {
        recipient_id: authUser.userId,
        status: status as "pending" | "accepted" | "declined" | "blocked",
      },
      include: {
        sender: {
          select: {
            id: true,
            name: true,
            image: true,
          },
        },
      },
      orderBy: { created_at: "desc" },
      skip: offset,
      take: limit,
    })

    return successResponse({
      requests: requests.map((r) => ({
        id: r.id,
        senderId: r.sender_id,
        sender: {
          id: r.sender.id,
          name: r.sender.name,
          avatar: r.sender.image,
        },
        message: r.message,
        status: r.status,
        createdAt: r.created_at,
      })),
      totalCount,
    })
  } catch (error) {
    logger.error("Get message requests error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to get message requests")
  }
}
