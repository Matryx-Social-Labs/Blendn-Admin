import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { z } from "zod"
import { ConversationClosedError, blockedEitherWay, openConversation } from "@/lib/conversations"
import { db } from "@/lib/db"
import { eventAccessResponse, participationRefusal } from "@/lib/event-access"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { sendPushNotification } from "@/lib/push-notifications"
import {
  successResponse,
  unauthorizedResponse,
  validationErrorResponse,
  errorResponse,
  conflictResponse,
  forbiddenResponse,
  notFoundResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { readJson, isUuid } from "@/lib/api-input"
import { evictBlockedFromBlends } from "@/lib/crews/like"
import { blockPairIn } from "@/lib/block-pair"
import { requestSeen } from "@/lib/block-seen"
import { notifyFriendshipChanged } from "@/lib/room-friends"
import { closeConversationRoom } from "@/lib/socket-server"
import { REACHABLE } from "@/lib/room-people"

interface RouteParams {
  params: Promise<{ requestId: string }>
}

const respondSchema = z.object({
  action: z.enum(["accept", "decline", "block"]),
})

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    const limited = await rateLimit(request, userLimit("write", "message-request-respond", authUser.userId))
    if (limited) return limited

    const { requestId } = await params

    if (!isUuid(requestId)) {
      return errorResponse("Invalid request ID format", 400)
    }

    const body = await readJson(request)
    const parsed = respondSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }

    const { action } = parsed.data

    // Accepting opens a conversation: an account known to be under 18 may not (SCRUM-1169). Decline and block stay open to everyone.
    if (action === "accept") {
      const denial = await participationRefusal(authUser.userId)
      if (denial?.kind === "age") return eventAccessResponse(denial)
    }

    // Get the message request
    // Accepting opens a conversation: from somebody who cannot be reached (`REACHABLE`), there is no request to accept.
    const messageRequest = await db.message_requests.findFirst({
      where: { id: requestId, ...(action === "accept" && { sender: REACHABLE }) },
      include: {
        sender: {
          select: {
            id: true,
            name: true,
            image: true,
          },
        },
      },
    })

    /*
     * A request that is not yours to answer is, to you, not found.
     *
     * This said 403 "You can only respond to requests sent to you", which told
     * a sender their id was real — and `POST /message-requests` now answers a
     * request it will not deliver with an id that is not (SCRUM-371). Two
     * answers would let a sender check which of their requests exist, and so
     * which room handle was their friend.
     */
    if (!messageRequest || messageRequest.recipient_id !== authUser.userId) {
      return notFoundResponse("Message request not found")
    }

    // Verify the request is still pending
    if (messageRequest.status !== "pending") {
      return errorResponse(
        `This request has already been ${messageRequest.status}`
      )
    }

    const now = new Date()

    // Map action to status
    const statusMap = {
      accept: "accepted",
      decline: "declined",
      block: "blocked",
    } as const

    const newStatus = statusMap[action]

    // Update the message request
    await db.message_requests.update({
      where: { id: requestId },
      data: {
        status: newStatus,
        responded_at: now,
        updated_at: now,
      },
    })

    let conversationId: string | null = null

    // If accepted, create a private conversation.
    //
    // Through the shared helper, which sorts the pair. This used to write
    // (sender, recipient) in request order while POST /conversations wrote them
    // sorted — and `@@unique([user1_id, user2_id])` cannot tell that (a, b) and
    // (b, a) are the same two people, so one pair could end up with two rows.
    if (action === "accept") {
      /*
       * Re-check the block at accept time, not only at request time.
       *
       * A request can sit pending for days, and either party may have blocked
       * the other in between. Without this, accepting an old request creates a
       * conversation between two blocked people -- and once that row exists,
       * `mayConverse` returns true for them forever.
       */
      if (await blockedEitherWay(messageRequest.sender_id, authUser.userId)) {
        return forbiddenResponse("This request can no longer be accepted")
      }
      try {
        const conversation = await openConversation(messageRequest.sender_id, authUser.userId)
        conversationId = conversation.id
      } catch (e) {
        // These two left each other before. Accepting a request cannot undo
        // that -- leaving is permanent -- and silently handing back the closed
        // row would give both sides a thread that is invisible in their inbox
        // and refuses every message.
        if (e instanceof ConversationClosedError) {
          return conflictResponse("This conversation was closed and cannot be reopened")
        }
        throw e
      }
    }

    /*
     * "Block" has to actually block.
     *
     * This set the request's status to `blocked` and stopped there, writing no
     * `blocked_users` row — so the only thing enforcing blocks anywhere saw
     * nothing, and the sender could simply send again. The status was a label on
     * a request; the block is a fact about two people.
     *
     * Idempotent: blocking someone who is already blocked is not an error.
     */
    if (action === "block") {
      // The same block as every other door (lib/block-pair.ts): the row, the
      // friendship and every friend request, crew invites, and the conversation.
      const seen = await requestSeen(messageRequest)
      const closedId = await db.$transaction((tx) => blockPairIn(tx, authUser.userId, messageRequest.sender_id, seen))
      if (closedId) closeConversationRoom(closedId)
      void notifyFriendshipChanged(authUser.userId, messageRequest.sender_id)
      // Out of any Blend room that now refuses them; the Blend goes on for the rest (D-9).
      await evictBlockedFromBlends(authUser.userId, messageRequest.sender_id)
    }

    /*
     * Only an accept tells the sender anything (SCRUM-621).
     *
     * A decline is not delivered: the product has no declined state, and the
     * owner ruled on 2026-10-09 (N1) that a no is silent -- no push, no bell
     * row, nothing the sender reads changes. This used to push "Message request
     * declined" to their devices; its bell row only failed to land by accident
     * (`conversationId: undefined` is not storable JSON), so the push was the
     * whole leak. The sender's own list still reads the request as it always
     * has, and `block` was never announced.
     *
     * The accepter is not named on it (launch gate 7, SCRUM-1266). The request
     * is the crossing to real names, but in the app, behind sign-in: a lock
     * screen is not an authenticated surface. The conversation the push opens
     * shows who.
     */
    if (action === "accept") {
      // Async, don't await: push is best-effort and must not fail the request.
      sendPushNotification({
        userId: messageRequest.sender_id,
        title: "Message request accepted",
        body: "Your message request was accepted",
        data: {
          type: "message_request_response",
          requestId,
          conversationId: conversationId ?? undefined,
        },
      }).catch((err: unknown) =>
        // Swallowing the error entirely would make a broken push pipeline invisible.
        logger.warn("Push notification failed", {
          context: "message request response",
          error: err instanceof Error ? err.message : String(err),
        })
      )
    }

    return successResponse({
      success: true,
      status: newStatus,
      conversationId,
      sender: {
        id: messageRequest.sender.id,
        name: messageRequest.sender.name,
        avatar: messageRequest.sender.image,
      },
    })
  } catch (error) {
    logger.error("Respond to message request error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to respond to message request")
  }
}
