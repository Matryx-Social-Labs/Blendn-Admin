import { NextRequest } from "next/server"

import {
  forbiddenResponse,
  notFoundResponse,
  serverErrorResponse,
  successResponse,
  unauthorizedResponse,
} from "@/lib/api-response"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { getPollResults } from "@/lib/poll-actions"
import { Refusal } from "@/lib/refusal"

interface RouteParams {
  params: Promise<{ eventId: string; pollId: string }>
}

/**
 * One poll's state for this reader.
 *
 * Counts come back already disclosed — `null` where withheld, and a sentence
 * saying so. The route deliberately has no "raw" mode: an endpoint that can
 * return the true numbers is one an organiser's own dashboard will eventually
 * call, and then the floor protects nobody.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { eventId, pollId } = await params

    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")

    return successResponse(await getPollResults(pollId, { userId: authUser.userId, eventId }))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message === "Poll not found") return notFoundResponse(message)
    // Not in the room, or removed from it: the room's own refusal (SCRUM-298).
    if (err instanceof Refusal) return forbiddenResponse(message)
    logger.error("Error reading poll", { error: message })
    return serverErrorResponse()
  }
}

export const dynamic = "force-dynamic"
