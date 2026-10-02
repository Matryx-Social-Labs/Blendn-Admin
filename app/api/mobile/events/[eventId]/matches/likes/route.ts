import { NextRequest } from "next/server"
import { z } from "zod"

import {
  errorResponse,
  forbiddenResponse,
  notFoundResponse,
  serverErrorResponse,
  successResponse,
  unauthorizedResponse,
  validationErrorResponse,
} from "@/lib/api-response"
import { blockedEitherWay, pairIsClosed } from "@/lib/conversations"
import { db } from "@/lib/db"
import { inRoomWhere } from "@/lib/event-kind"
import { logger } from "@/lib/logger"
import { likeAtEvent } from "@/lib/matches"
import { isRefusal, refusalResponse } from "@/lib/crews/crews"
import { likePersonAsCrew } from "@/lib/crews/like"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { announceRoomMatch } from "@/lib/room-match"
import { roomMemberFromRef } from "@/lib/room-handle"
import { readJson, isUuid } from "@/lib/api-input"

interface RouteParams {
  params: Promise<{ eventId: string }>
}

// User ids are cuid, not uuid — do not tighten this to z.string().uuid(). And
// the deck sends room handles (`rh_…`, SCRUM-371), which are neither.
const likeSchema = z.object({
  userId: z.string().min(1),
  /** Like them on your crew's behalf (crew → person, step 8): lib/crews/like.ts decides. */
  asCrewId: z.string().uuid().optional(),
})

/**
 * Like someone who was in the room with you.
 *
 * A mutual like opens a conversation. That is not a bypass of the message
 * request flow — a request exists to establish that both people agreed to talk,
 * and two likes are exactly that, reached without either side having to compose
 * an opener to a stranger. `mayConverse` accepts the resulting conversation for
 * the same reason.
 *
 * The response says whether it was mutual. It never says whether *they* liked
 * you first, and there is no endpoint that does — surfacing that is how this
 * becomes a product where the interesting information sits behind a payment,
 * and it would drain the gesture of the only thing that makes it mean anything.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { eventId } = await params
    if (!isUuid(eventId)) return errorResponse("Invalid event ID format", 400)

    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")

    const limited = await rateLimit(request, userLimit("write", "event-like", authUser.userId))
    if (limited) return limited

    const parsed = likeSchema.safeParse(await readJson(request))
    if (!parsed.success) return validationErrorResponse(parsed.error)
    // Only the handle this room's deck showed you, or your own id (refused
    // just below). Anything else — a raw id, another room's handle, a forged
    // one — is nobody here and is answered as an unknown id: a raw-id like
    // would say whether that account is in this room (`roomMemberFromRef`).
    const likedId = roomMemberFromRef(eventId, parsed.data.userId, authUser.userId)

    if (likedId === authUser.userId) {
      return errorResponse("You cannot like yourself")
    }

    /*
     * On a crew's behalf: a different like with its own guardrails — the
     * person opted in to crews, the crew has room for one more and is 6 or
     * fewer, dating only if both chose it, no block across any member — and
     * its own outcome, a Blend rather than a conversation. One writer of
     * `crew_likes` (lib/crews/like.ts).
     */
    if (parsed.data.asCrewId) {
      if (!likedId) return notFoundResponse("User not found")
      const outcome = await likePersonAsCrew(authUser.userId, eventId, parsed.data.asCrewId, likedId)
      return isRefusal(outcome) ? refusalResponse(outcome) : successResponse(outcome)
    }

    /*
     * Both of you have to have actually been here.
     *
     * Without this the endpoint is a way to like any user id you can guess,
     * which is the same hole the message request flow had — and this one would
     * additionally *open a conversation* the moment the other person liked back,
     * from an event neither of them shared.
     */
    const [mine, theirs] = await Promise.all([
      // Both in the room — at a venue day, both live there now (`inRoomWhere`).
      db.event_check_ins.findFirst({
        where: { event_id: eventId, user_id: authUser.userId, check_in_time: { not: null }, ...inRoomWhere(authUser.userId) },
        select: { id: true },
      }),
      likedId && db.event_check_ins.findFirst({
        where: {
          event_id: eventId,
          user_id: likedId,
          check_in_time: { not: null },
          ...inRoomWhere(),
          // Staff are working. They are not in the match list, so they cannot be
          // liked through it either.
          kind: "attendee",
        },
        select: { id: true },
      }),
    ])

    if (!mine) return forbiddenResponse("Check in before liking anyone here")
    // Not "they weren't here" — that would confirm who did and did not attend to
    // anyone probing user ids.
    if (!theirs || !likedId) return notFoundResponse("User not found")

    if (await blockedEitherWay(authUser.userId, likedId)) {
      return notFoundResponse("User not found")
    }

    /*
     * Leaving is permanent, and the pool is not the gate.
     *
     * `lib/matches.ts` hides closed pairs from the ranked list, but that is
     * only what the client renders -- this endpoint takes a user id directly.
     * Without the check, someone who unmatched could like the same person
     * again, hit the reciprocal like that was never deleted, and get
     * `mutual: true` back pointing at a conversation that is closed.
     *
     * Same shape as the block response above, and deliberately the same words:
     * a distinct error here would tell the caller "this specific person
     * unmatched you", which is a rejection notice by another name.
     */
    if (await pairIsClosed(authUser.userId, likedId)) {
      return notFoundResponse("User not found")
    }

    const outcome = await likeAtEvent(eventId, authUser.userId, likedId)

    /*
     * `room:match` to both of them, each naming the other as they see them.
     * Awaited so it is sent before the response rather than racing it, but it
     * cannot fail the like: `announceRoomMatch` never rejects.
     */
    if (outcome.mutual && outcome.conversationId) {
      await announceRoomMatch(eventId, outcome.conversationId)
    }

    return successResponse(outcome)
  } catch (error) {
    logger.error("Like error", {
      error: error instanceof Error ? error.message : String(error),
    })
    return serverErrorResponse("Failed to record like")
  }
}
