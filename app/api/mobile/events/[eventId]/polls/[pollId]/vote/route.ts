import { NextRequest } from "next/server"
import { z } from "zod"

import {
  errorResponse,
  notFoundResponse,
  serverErrorResponse,
  successResponse,
  unauthorizedResponse,
  validationErrorResponse,
} from "@/lib/api-response"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { castVote, getPollResults } from "@/lib/poll-actions"
import { rateLimit, userLimit } from "@/lib/rate-limit"

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
    const { pollId } = await params

    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")

    const limited = await rateLimit(request, userLimit("write", "poll-vote", authUser.userId))
    if (limited) return limited

    const parsed = voteSchema.safeParse(await request.json())
    if (!parsed.success) return validationErrorResponse(parsed.error)

    await castVote(pollId, parsed.data.optionId, authUser.userId)

    return successResponse(await getPollResults(pollId, authUser.userId))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message === "Poll not found") return notFoundResponse(message)
    /*
     * These are all things the voter can act on — a closed poll, a room they
     * left, an option from another poll — so they come back as themselves rather
     * than as a 500. Anything else is a fault and says nothing.
     */
    if (
      message === "This poll has closed" ||
      message === "The chatroom is not open" ||
      message === "You are not in this chatroom" ||
      message === "That is not an option on this poll"
    ) {
      return errorResponse(message, 409)
    }
    logger.error("Error casting vote", { error: message })
    return serverErrorResponse()
  }
}

export const dynamic = "force-dynamic"
