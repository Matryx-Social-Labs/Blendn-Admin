import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { z } from "zod"

import { ALREADY_ASKED, BOARD_CLOSED, boardDenialMessage } from "@/lib/board"
import { boardWriteDenial, checkBoardText } from "@/lib/board-access"
import { BOARD } from "@/lib/constants"
import { blockCounterparties } from "@/lib/conversations"
import { db } from "@/lib/db"
import { attendeeEventAccess, eventAccessResponse } from "@/lib/event-access"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { notifyBoardRequest } from "@/lib/push-notifications"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import {
  successResponse,
  errorResponse,
  validationErrorResponse,
  unauthorizedResponse,
  forbiddenResponse,
  notFoundResponse,
  conflictResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { isUuid, readOptionalJson } from "@/lib/api-input"

interface RouteParams {
  params: Promise<{ eventId: string; postId: string }>
}

/**
 * Asking somebody who posted whether you can come with them.
 *
 * ## Why there is no cold-request route
 *
 * A request is filed against a post, and `board_requests.post_id` is required.
 * That is the whole of the "you cannot cold-request a person who has not
 * posted" rule — it is structural rather than a check, so there is no path
 * that forgets it and no branch to test. Somebody who has not put themselves
 * forward cannot be asked at all.
 */

const requestSchema = z.object({
  /**
   * Optional. "Can I join?" needs no essay, and requiring one would make the
   * ask heavier than the thing being asked for.
   */
  message: z.string().trim().max(BOARD.MAX_REQUEST_LENGTH).optional(),
})

// POST /api/mobile/events/[eventId]/board/[postId]/requests
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return unauthorizedResponse("Authentication required")

    const limited = await rateLimit(request, userLimit("write", "board-request", user.userId))
    if (limited) return limited

    const { eventId, postId } = await params
    if (!isUuid(eventId)) return errorResponse("Invalid event ID format", 400)
    if (!isUuid(postId)) return errorResponse("Invalid post ID format", 400)

    const validation = requestSchema.safeParse(await readOptionalJson(request))
    if (!validation.success) return validationErrorResponse(validation.error)
    const { message } = validation.data

    /*
     * The board closes at doors, and so does asking.
     *
     * An accepted request opens a conversation, so a request answered after the
     * event started would open one on the strength of an intent that has
     * already been overtaken by whether they actually turned up.
     */
    const denied = await attendeeEventAccess(user.userId, eventId, "participate")
    if (denied) return eventAccessResponse(denied)
    const event = await db.events.findUnique({
      where: { id: eventId, deleted_at: null },
      select: { id: true, start_time: true },
    })
    if (!event) return notFoundResponse("Event not found")
    if (event.start_time <= new Date()) return errorResponse(BOARD_CLOSED, 403)

    const post = await db.board_posts.findFirst({
      where: { id: postId, event_id: eventId, deleted_at: null },
      select: { id: true, author_id: true, kind: true, spaces_left: true },
    })
    if (!post) return notFoundResponse("That post is no longer on the board")

    if (post.author_id === user.userId) {
      return errorResponse("That is your own post", 400)
    }

    /*
     * Blocks reach the board.
     *
     * `blockCounterparties` is both directions, which is the half that gets
     * missed: someone you blocked must not be able to reach you either, and a
     * board request is a message to a stranger with a name attached to it at
     * the other end. This is the sixth surface the block has had to be taught
     * about, which is the argument for `enforce()` in the plan.
     *
     * The refusal is deliberately the same sentence as a deleted post. Telling
     * the asker they have been blocked tells them a fact about somebody else's
     * decision, which is the one thing a block should not leak.
     */
    const blocked = await blockCounterparties(user.userId)
    if (blocked.includes(post.author_id)) {
      return notFoundResponse("That post is no longer on the board")
    }

    // A chat post asks nothing of anybody, so there is nothing to ask to join.
    if (post.kind === "chat") return errorResponse("A chat post doesn't take requests", 422)
    // The board already shows it full; an ask on it could only be refused.
    if (post.spaces_left === 0) return conflictResponse("That offer is full")

    const denial = await boardWriteDenial(eventId, user.userId)
    if (denial) return forbiddenResponse(boardDenialMessage(denial))

    /*
     * One ask per post, ever — whatever became of it.
     *
     * Refusing a re-ask only after a decline was a delivery of the decline:
     * the one answer a second ask can be refused after is a no, so "you cannot
     * ask again" told the asker what the other person decided. And refusing it
     * after a decline but not after a withdrawal fails the same way one step
     * later — a declined ask can be withdrawn, and the refusal on re-asking it
     * would differ from a plain withdrawal's. So every earlier ask, pending,
     * declined, withdrawn or accepted, answers with the same sentence the
     * pending race below does.
     */
    const asked = await db.board_requests.findFirst({
      where: { post_id: postId, from_user_id: user.userId },
      select: { id: true },
    })
    if (asked) return conflictResponse(ALREADY_ASKED)

    /*
     * The message is read by one person the sender chose — riskier than a
     * post, not less — so it gets the post's checks (SCRUM-301). A request has
     * nowhere to be hidden later, so there is no second look on a timeout.
     */
    if (message) {
      const verdict = await checkBoardText(message)
      if (verdict.refusal) return errorResponse(verdict.refusal, 422)
    }

    let created
    try {
      created = await db.board_requests.create({
        data: {
          event_id: eventId,
          post_id: postId,
          from_user_id: user.userId,
          to_user_id: post.author_id,
          ...(message && { message }),
        },
        select: { id: true, status: true, created_at: true },
      })
    } catch (error) {
      /*
       * The unique `(post_id, from_user_id)`, doing its job: one ask per post,
       * ever. The read above answers the ordinary re-ask; this answers the one
       * that raced it — a double tap on a slow connection, which is the
       * ordinary way a client retry happens rather than the exceptional one.
       */
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: string }).code === "P2002"
      ) {
        return conflictResponse(ALREADY_ASKED)
      }
      throw error
    }

    // Fire and forget: a push that fails must not fail the ask.
    notifyBoardRequest(post.author_id, eventId, created.id).catch((error) =>
      logger.warn("Board request notification failed", {
        requestId: created.id,
        error: String(error),
      })
    )

    return successResponse(
      { id: created.id, status: created.status, createdAt: created.created_at },
      201
    )
  } catch (error) {
    logger.error("Board request error", {
      error: error instanceof Error ? error.message : String(error),
    })
    return serverErrorResponse("Failed to send the request")
  }
}
