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
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { castVote, getPollResults, pollVoteReason } from "@/lib/polls"
import { Refusal } from "@/lib/refusal"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { readJson, isUuid } from "@/lib/api-input"

interface RouteParams {
  params: Promise<{ eventId: string; pollId: string }>
}

const voteSchema = z.object({ optionId: z.string().uuid() })

/**
 * Cast or change a vote.
 *
 * The response is the poll's disclosed state, not a bare acknowledgement, so the
 * client renders the same numbers the server would send on a re-read. A client
 * that increments locally would show a count the disclosure rule has withheld.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { eventId, pollId } = await params
    if (!isUuid(eventId)) return errorResponse("Invalid event ID format", 400)
    if (!isUuid(pollId)) return errorResponse("Invalid poll ID format", 400)

    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")

    const limited = await rateLimit(request, userLimit("write", "poll-vote", authUser.userId))
    if (limited) return limited

    const parsed = voteSchema.safeParse(await readJson(request))
    if (!parsed.success) return validationErrorResponse(parsed.error)

    await castVote(pollId, parsed.data.optionId, authUser.userId, eventId)

    return successResponse(await getPollResults(pollId, { userId: authUser.userId, eventId }))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message === "Poll not found") return notFoundResponse(message)
    /*
     * These are all things the voter can act on — a closed poll, a room they
     * left, an option from another poll, a venue day they are no longer live
     * in — so they come back as themselves, with the sentence to show and a
     * `reasonCode` to branch on, rather than as a 500. `errorCode` stays
     * `CONFLICT`. Anything else is a fault and says nothing.
     */
    const reason = pollVoteReason(message)
    if (reason) return errorResponse(message, 409, undefined, reason)
    // The room's own refusal (a banned member reading the results back), as the GET says it.
    if (err instanceof Refusal) return forbiddenResponse(message)
    logger.error("Error casting vote", { error: message })
    return serverErrorResponse()
  }
}

export const dynamic = "force-dynamic"
