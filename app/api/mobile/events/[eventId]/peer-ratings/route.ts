import { NextRequest } from "next/server"
import { z } from "zod"

import {
  errorResponse,
  forbiddenResponse,
  serverErrorResponse,
  successResponse,
  unauthorizedResponse,
  validationErrorResponse,
} from "@/lib/api-response"
import { db } from "@/lib/db"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { ratablePeers } from "@/lib/trust"

interface RouteParams {
  params: Promise<{ eventId: string }>
}

const ratingSchema = z.object({
  // cuid, not uuid — do not tighten this.
  userId: z.string().min(1),
  rating: z.number().int().min(1).max(5),
  issue: z.enum(["none", "uncomfortable", "no_show", "misrepresented", "harassment"]).optional(),
  note: z.string().max(1000).optional(),
})

/**
 * Who you can still rate for this event.
 *
 * The client asks this at check-out or when the event ends, and shows nothing if
 * the list is empty — which is the common case, since most people connect with
 * nobody and there is no reason to prompt them.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { eventId } = await params
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")

    return successResponse({ userIds: await ratablePeers(eventId, authUser.userId) })
  } catch (error) {
    logger.error("Ratable peers error", {
      error: error instanceof Error ? error.message : String(error),
    })
    return serverErrorResponse("Failed to load")
  }
}

/**
 * Rate someone you met.
 *
 * **Never visible to the person rated**, and there is no endpoint that returns
 * it to them. Nobody reports discomfort honestly when the subject will see it
 * and knows exactly who was there.
 *
 * A harassment report is not a low rating with a label. It goes to moderation on
 * its own and is never averaged into a score.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { eventId } = await params
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")

    const limited = await rateLimit(request, userLimit("write", "peer-rating", authUser.userId))
    if (limited) return limited

    const parsed = ratingSchema.safeParse(await request.json())
    if (!parsed.success) return validationErrorResponse(parsed.error)
    const { userId: ratedId, rating, issue = "none", note } = parsed.data

    if (ratedId === authUser.userId) return errorResponse("You cannot rate yourself")

    /*
     * The gate, and the whole integrity of this table: you may only rate someone
     * you connected with, at an event that has finished. `ratablePeers` also
     * excludes anyone you have already rated, so the unique constraint is a
     * backstop rather than the rule.
     */
    const allowed = await ratablePeers(eventId, authUser.userId)
    if (!allowed.includes(ratedId)) {
      return forbiddenResponse("You can only rate someone you connected with, after the event")
    }

    await db.peer_ratings.create({
      data: { event_id: eventId, rater_id: authUser.userId, rated_id: ratedId, rating, issue, note },
    })

    if (issue === "harassment") {
      // Loud on purpose. This is the one path where a human should be looking
      // before any aggregate is consulted.
      logger.error("Harassment reported via peer rating", { eventId, ratedId })
    }

    // Deliberately returns nothing about the person rated — not their trust
    // signal, not their other ratings, not whether anyone else reported them.
    return successResponse({ recorded: true })
  } catch (error) {
    logger.error("Peer rating error", {
      error: error instanceof Error ? error.message : String(error),
    })
    return serverErrorResponse("Failed to record rating")
  }
}
