import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { z } from "zod"

import { boardPseudonyms, isLiveRequest, liveRequest, seatBoardRoom } from "@/lib/board-access"
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
  errorResponse,
} from "@/lib/api-response"
import { readJson, isUuid } from "@/lib/api-input"

interface RouteParams {
  params: Promise<{ requestId: string }>
}

/**
 * Thrown inside the accept transaction to roll everything in it back; the
 * message is the sentence the author is answered with.
 */
class AcceptRefused extends Error {}

/*
 * One sentence, one status, for a block and a closed pair alike. A 403 for one
 * and a 409 for the other, around the same words, told the author which.
 */
const CANNOT_ACCEPT = "This request can no longer be accepted"

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
    if (!isUuid(requestId)) return errorResponse("Invalid request ID format", 400)

    const validation = decisionSchema.safeParse(await readJson(request))
    if (!validation.success) return validationErrorResponse(validation.error)
    const { action } = validation.data

    const boardRequest = await db.board_requests.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        status: true,
        event_id: true,
        post_id: true,
        from_user_id: true,
        to_user_id: true,
        event: { select: { end_time: true } },
        post: { select: { deleted_at: true, spaces_left: true, body: true } },
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
    if (action === "withdraw") {
      if (!isAsker) return forbiddenResponse("Only the person who asked can withdraw it")
      return withdraw(requestId)
    }
    if (!isRecipient) {
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
     * Declining stays open. It is record-keeping, it costs nothing, and the
     * cap no longer depends on it: it counts live requests, so a lapsed ask has
     * already stopped occupying a slot.
     */
    if (action === "accept" && !isLiveRequest(boardRequest)) {
      return conflictResponse(
        boardRequest.post.deleted_at ? "That post was taken down" : "That event has ended"
      )
    }

    if (action === "decline") {
      /*
       * `updateMany` with the status in the where clause, not `update`.
       *
       * The read above is not a lock, so two taps — or a decline racing an
       * accept — both pass it. Making `pending` part of the predicate means
       * exactly one of them writes, and the loser is told the truth rather than
       * silently overwriting the first answer.
       *
       * Nothing is sent to the asker, and nothing they read changes: to them a
       * declined ask stays pending until it lapses (`asTheAskerSees`).
       */
      const claimed = await db.board_requests.updateMany({
        where: { id: requestId, status: "pending" },
        data: { status: "declined", decided_at: new Date() },
      })
      if (claimed.count === 0) {
        return conflictResponse("That request has already been answered")
      }
      return successResponse({ id: requestId, status: "declined" })
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
    if (blocked.includes(boardRequest.from_user_id)) return conflictResponse(CANNOT_ACCEPT)

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
    if (existing?.closed_at) return conflictResponse(CANNOT_ACCEPT)

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

    /*
     * The claim, the seat and the conversation, in one transaction (SCRUM-514).
     *
     * An offer of two seats accepted three times is a car with three people
     * promised two places. The reads above are not a lock, so every guard is
     * in a write's predicate:
     *
     * - the claim takes only a request still live (`liveRequest`: pending, its
     *   event not over, its post not taken down) — a post removed mid-accept
     *   is caught here, not missed;
     * - the seat is taken only while `spaces_left > 0` on a post still up. Two
     *   accepts racing for the last seat queue on the post's row; the second
     *   finds none and is refused. The CHECK on the column keeps it from going
     *   below zero even if the predicate were lost;
     * - the conversation is opened with the same client, so a closed pair
     *   (`ConversationClosedError`) or any failure undoes the claim and the
     *   seat with it. There is nothing to give back by hand, and no crash
     *   between two writes leaves an accepted ask with a spent seat and no
     *   conversation behind it.
     *
     * An offer that never named a number of seats (`spaces_left` null) has
     * none to run out of; only offers can have one (a CHECK).
     */
    const takesASeat = boardRequest.post.spaces_left !== null
    let conversation
    try {
      conversation = await db.$transaction(async (tx) => {
        const now = new Date()
        /*
         * Accepts on one post queue here: the room below counts the accepted
         * asks, and two accepts at once must each see the other.
         */
        await tx.$executeRaw`SELECT 1 FROM board_posts WHERE id = ${boardRequest.post_id}::uuid FOR UPDATE`
        const claim = await tx.board_requests.updateMany({
          where: { id: requestId, ...liveRequest(now) },
          data: { status: "accepted", decided_at: now },
        })
        if (claim.count === 0) {
          const current = await tx.board_requests.findUnique({
            where: { id: requestId },
            select: { status: true, post: { select: { deleted_at: true } } },
          })
          if (current?.status !== "pending") throw new AcceptRefused("That request has already been answered")
          throw new AcceptRefused(current.post.deleted_at ? "That post was taken down" : "That event has ended")
        }
        if (takesASeat) {
          const seat = await tx.board_posts.updateMany({
            where: { id: boardRequest.post_id, deleted_at: null, spaces_left: { gt: 0 } },
            data: { spaces_left: { decrement: 1 } },
          })
          if (seat.count === 0) throw new AcceptRefused("That offer is full")
        }
        const opened = await openConversation(
          boardRequest.from_user_id,
          boardRequest.to_user_id,
          { eventId: boardRequest.event_id, pseudonyms, boardRequestId: requestId },
          tx
        )
        // The post's room, once a second asker is in (CR-I16, SCRUM-535).
        await seatBoardRoom(tx, {
          id: boardRequest.post_id,
          event_id: boardRequest.event_id,
          author_id: boardRequest.to_user_id,
          body: boardRequest.post.body,
        })
        return opened
      })
    } catch (error) {
      if (error instanceof AcceptRefused) return conflictResponse(error.message)
      if (error instanceof ConversationClosedError) return conflictResponse(CANNOT_ACCEPT)
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

/**
 * The asker takes their ask back — which must not be where a decline lands.
 *
 * To the asker a declined ask is pending (`asTheAskerSees`), so withdrawing it
 * has to succeed exactly as withdrawing a pending one does. A 409 here was the
 * decline delivered as an error. Withdrawing twice is not news either, so it
 * succeeds again. Only an accepted ask is refused, and the asker was told about
 * that one.
 *
 * A pending ask becomes `withdrawn`. A declined one keeps `declined` and its
 * `decided_at` — the author's decision, which is theirs and not the asker's to
 * rewrite — and gets `asker_withdrawn_at`, the asker's half: they now see it
 * withdrawn, and it stops holding a slot in their cap. The re-ask is refused on
 * any earlier row (one ask per post, a unique index), so neither reopens the
 * post to them.
 */
async function withdraw(requestId: string) {
  const now = new Date()
  const [pending, declined] = await db.$transaction([
    db.board_requests.updateMany({
      where: { id: requestId, status: "pending" },
      data: { status: "withdrawn", decided_at: now },
    }),
    db.board_requests.updateMany({
      where: { id: requestId, status: "declined", asker_withdrawn_at: null },
      data: { asker_withdrawn_at: now },
    }),
  ])
  if (pending.count + declined.count === 0) {
    const current = await db.board_requests.findUnique({
      where: { id: requestId },
      select: { status: true, asker_withdrawn_at: true },
    })
    const alreadyWithdrawn =
      current?.status === "withdrawn" || (current?.status === "declined" && current.asker_withdrawn_at)
    if (!alreadyWithdrawn) return conflictResponse("That request has already been answered")
  }
  return successResponse({ id: requestId, status: "withdrawn" })
}
