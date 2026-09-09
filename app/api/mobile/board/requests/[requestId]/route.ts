import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { z } from "zod"

import { boardPseudonyms, isLiveRequest } from "@/lib/board-access"
import {
  blockCounterparties,
  conversationPair,
  openConversation,
  ConversationClosedError,
} from "@/lib/conversations"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { notifyBoardRequestAccepted } from "@/lib/push-notifications"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import {
  successResponse,
  validationErrorResponse,
  unauthorizedResponse,
  forbiddenResponse,
  notFoundResponse,
  conflictResponse,
  serverErrorResponse,
} from "@/lib/api-response"

interface RouteParams {
  params: Promise<{ requestId: string }>
}

/**
 * Answering a board request: yes, no, or never mind.
 *
 * ## Accepting is the whole of the board
 *
 * Everything else on this surface is people describing themselves to each
 * other. This is the one action that produces a channel between two strangers,
 * and it is the reason the gates on the other end are as heavy as they are.
 *
 * ## Why the co-presence rule needs no exception
 *
 * `USER_JOURNEY.md` lists as non-negotiable that a conversation requires having
 * been in the same room, and `mayConverse` enforces it — but it returns true
 * when a conversation already exists. So accepting simply opens one, and every
 * later check passes on the strength of the row rather than on an exception
 * carved into the rule. The plan anticipated needing a distinct conversation
 * kind that graduates; it does not, and the rule survives untouched.
 *
 * ## Why a decision is still possible after doors
 *
 * The board closes at doors and answering it does not. A pending request holds
 * a slot in the asker's outstanding cap, so refusing decisions after doors
 * would leave them permanently unanswerable and the cap permanently consumed —
 * one unanswered ask on a Tuesday costing a fifth of every future board.
 */

const decisionSchema = z.object({
  action: z.enum(["accept", "decline", "withdraw"]),
})

// PATCH /api/mobile/board/requests/[requestId]
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return unauthorizedResponse("Authentication required")

    const limited = await rateLimit(request, userLimit("write", "board-decide", user.userId))
    if (limited) return limited

    const { requestId } = await params

    const validation = decisionSchema.safeParse(await request.json())
    if (!validation.success) return validationErrorResponse(validation.error)
    const { action } = validation.data

    const boardRequest = await db.board_requests.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        status: true,
        event_id: true,
        from_user_id: true,
        to_user_id: true,
        event: { select: { end_time: true } },
        post: { select: { deleted_at: true } },
      },
    })
    if (!boardRequest) return notFoundResponse("Request not found")

    /*
     * Who may take which action, and it is not symmetric.
     *
     * Withdrawing is the asker taking back their own ask; accepting and
     * declining are the answer. `withdrawn` exists as a separate status from
     * `declined` for exactly this reason: afterwards, which of the two people
     * ended it is the thing worth knowing.
     */
    const isRecipient = boardRequest.to_user_id === user.userId
    const isAsker = boardRequest.from_user_id === user.userId
    if (!isRecipient && !isAsker) return notFoundResponse("Request not found")
    if (action === "withdraw" && !isAsker) {
      return forbiddenResponse("Only the person who asked can withdraw it")
    }
    if (action !== "withdraw" && !isRecipient) {
      return forbiddenResponse("Only the person who was asked can answer")
    }
    if (boardRequest.status !== "pending") {
      return conflictResponse("That request has already been answered")
    }

    /*
     * Pending, but there is nothing left to answer.
     *
     * Accepting opens a conversation, and a conversation about an evening that
     * already happened is a channel obtained by sitting on a request rather
     * than by agreeing to anything. The client renders these as closed — same
     * `isLiveRequest`, so the screen and the server cannot give two answers to
     * one question, which is the failure this codebase is mostly made of.
     *
     * Declining and withdrawing stay open. They are record-keeping, they cost
     * nothing, and the cap no longer depends on them: it counts live requests,
     * so a lapsed ask has already stopped occupying a slot.
     */
    if (action === "accept" && !isLiveRequest(boardRequest)) {
      return conflictResponse(
        boardRequest.post.deleted_at ? "That post was taken down" : "That event has ended"
      )
    }

    const nextStatus = action === "accept" ? "accepted" : action === "decline" ? "declined" : "withdrawn"

    if (action !== "accept") {
      /*
       * `updateMany` with the status in the where clause, not `update`.
       *
       * The read above is not a lock, so two taps — or a decline racing a
       * withdraw — both pass it. Making `pending` part of the predicate means
       * exactly one of them writes, and the loser is told the truth rather than
       * silently overwriting the first answer.
       */
      const claimed = await db.board_requests.updateMany({
        where: { id: requestId, status: "pending" },
        data: { status: nextStatus, decided_at: new Date() },
      })
      if (claimed.count === 0) {
        return conflictResponse("That request has already been answered")
      }
      return successResponse({ id: requestId, status: nextStatus })
    }

    /*
     * A block between the ask and the answer.
     *
     * The block route closes any existing conversation, so a pair who had one
     * is caught by the closed check below. A pair who did not is caught here
     * and only here — without it, accepting a request from somebody you blocked
     * afterwards opens a brand new channel to them, which is the block failing
     * at the one moment it is being tested.
     */
    const blocked = await blockCounterparties(user.userId)
    if (blocked.includes(boardRequest.from_user_id)) {
      return forbiddenResponse("This request can no longer be accepted")
    }

    /*
     * A closed pair, checked before the claim rather than after.
     *
     * `openConversation` refuses a closed pair by throwing, and unmatching is
     * permanent. Claiming first and discovering it second would leave the
     * request marked accepted with no conversation behind it — a state nothing
     * retries and no screen can explain.
     */
    const [user1_id, user2_id] = conversationPair(
      boardRequest.from_user_id,
      boardRequest.to_user_id
    )
    const existing = await db.private_conversations.findUnique({
      where: { user1_id_user2_id: { user1_id, user2_id } },
      select: { closed_at: true },
    })
    if (existing?.closed_at) {
      return conflictResponse("This request can no longer be accepted")
    }

    const claimed = await db.board_requests.updateMany({
      where: { id: requestId, status: "pending" },
      data: { status: "accepted", decided_at: new Date() },
    })
    if (claimed.count === 0) {
      return conflictResponse("That request has already been answered")
    }

    let conversation
    try {
      /*
       * Pseudonymous, and that is not decoration.
       *
       * `displayNameInConversation` falls back to the real name when there is
       * no pseudonym, so a board conversation opened without one would hand
       * over both real names at the moment of acceptance — the leak this
       * product exists to prevent, arriving through its newest surface.
       *
       * `boardRequestId` is what stops the same conversation being read as a
       * match. Both are pseudonymous, so provenance cannot be inferred from
       * the pseudonyms; without the marker the client draws the match opener
       * on two people who agreed to share a car.
       */
      const pseudonyms = Object.fromEntries(
        await boardPseudonyms(boardRequest.event_id, [
          boardRequest.from_user_id,
          boardRequest.to_user_id,
        ])
      )
      conversation = await openConversation(
        boardRequest.from_user_id,
        boardRequest.to_user_id,
        { eventId: boardRequest.event_id, pseudonyms, boardRequestId: requestId }
      )
    } catch (error) {
      // Put it back, so the ask is answerable rather than accepted-into-nothing.
      await db.board_requests.updateMany({
        where: { id: requestId, status: "accepted" },
        data: { status: "pending", decided_at: null },
      })
      if (error instanceof ConversationClosedError) {
        return conflictResponse("This request can no longer be accepted")
      }
      throw error
    }

    notifyBoardRequestAccepted(boardRequest.from_user_id, conversation.id).catch((error) =>
      logger.warn("Board acceptance notification failed", {
        requestId,
        error: String(error),
      })
    )

    return successResponse({
      id: requestId,
      status: "accepted",
      conversationId: conversation.id,
    })
  } catch (error) {
    logger.error("Board request decision error", {
      error: error instanceof Error ? error.message : String(error),
    })
    return serverErrorResponse("Failed to answer the request")
  }
}
