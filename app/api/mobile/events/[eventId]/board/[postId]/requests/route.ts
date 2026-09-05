import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { z } from "zod"

import { boardDenialMessage } from "@/lib/board"
import { boardWriteDenial } from "@/lib/board-access"
import { BOARD } from "@/lib/constants"
import { blockCounterparties } from "@/lib/conversations"
import { db } from "@/lib/db"
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

    const body = await request.json().catch(() => ({}))
    const validation = requestSchema.safeParse(body ?? {})
    if (!validation.success) return validationErrorResponse(validation.error)
    const { message } = validation.data

    /*
     * The board closes at doors, and so does asking.
     *
     * An accepted request opens a conversation, so a request answered after the
     * event started would open one on the strength of an intent that has
     * already been overtaken by whether they actually turned up.
     */
    const event = await db.events.findUnique({
      where: { id: eventId, deleted_at: null },
      select: { id: true, start_time: true },
    })
    if (!event) return notFoundResponse("Event not found")
    if (event.start_time <= new Date()) {
      return errorResponse("The board closes when the doors open — the room is open instead", 403)
    }

    const post = await db.board_posts.findFirst({
      where: { id: postId, event_id: eventId, deleted_at: null },
      select: { id: true, author_id: true },
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

    const denial = await boardWriteDenial(eventId, user.userId)
    if (denial) return forbiddenResponse(boardDenialMessage(denial))

    /*
     * They already said no to this.
     *
     * The partial unique below only stops a *second pending* request, so
     * without this a decline is followed by an identical ask a second later,
     * for ever. The weekly cap bounds the total; this bounds the pestering of
     * one person who has already answered.
     *
     * `withdrawn` is deliberately not included: withdrawing is the asker
     * changing their own mind, and it has told the other person nothing.
     */
    const refused = await db.board_requests.findFirst({
      where: {
        post_id: postId,
        from_user_id: user.userId,
        status: "declined",
      },
      select: { id: true },
    })
    if (refused) return conflictResponse("They have already answered this one")

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
       * The partial unique `board_requests_one_pending_per_post`, doing its job:
       * at most one pending request per direction per post. A double tap on a
       * slow connection asks the same person the same question twice, which is
       * exactly the pestering the caps exist to prevent, and a client retry is
       * the ordinary way it happens rather than the exceptional one.
       */
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: string }).code === "P2002"
      ) {
        return conflictResponse("You have already asked — give them a moment")
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
