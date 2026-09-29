import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { z } from "zod"
import { acceptFriendRequest, dismissFriendRequest, withdrawFriendRequest } from "@/lib/friends"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { participationRefusal } from "@/lib/event-access"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import {
  successResponse,
  unauthorizedResponse,
  validationErrorResponse,
  notFoundResponse,
  forbiddenResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { readJson, isUuid } from "@/lib/api-input"

type RouteParams = { params: Promise<{ requestId: string }> }

const respondSchema = z.object({ action: z.enum(["accept", "dismiss"]) })

/**
 * POST /api/mobile/friends/requests/:requestId — the recipient answers.
 *
 * `accept` makes the friendship. `dismiss` is "Not now": hidden from the
 * recipient, never reported to the sender. Only the recipient may answer;
 * anybody else gets the 404 a missing request gets.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")

    const limited = await rateLimit(request, userLimit("write", "friend-respond", authUser.userId))
    if (limited) return limited

    const parsed = respondSchema.safeParse(await readJson(request))
    if (!parsed.success) return validationErrorResponse(parsed.error)

    const { requestId } = await params
    if (!isUuid(requestId)) return notFoundResponse("Not found")

    if (parsed.data.action === "accept") {
      // Becoming friends is taking part, as asking is (SCRUM-331).
      const unfinished = await participationRefusal(authUser.userId)
      if (unfinished) return forbiddenResponse(unfinished)
      if (!(await acceptFriendRequest(requestId, authUser.userId))) return notFoundResponse("Not found")
      return successResponse({ state: "friends" })
    }
    if (!(await dismissFriendRequest(requestId, authUser.userId))) return notFoundResponse("Not found")
    return successResponse({ dismissed: true })
  } catch (error) {
    logger.error("Respond to friend request error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to answer friend request")
  }
}

/** DELETE /api/mobile/friends/requests/:requestId — the sender takes it back. */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")

    const limited = await rateLimit(request, userLimit("write", "friend-withdraw", authUser.userId))
    if (limited) return limited

    const { requestId } = await params
    if (!isUuid(requestId) || !(await withdrawFriendRequest(requestId, authUser.userId))) {
      return notFoundResponse("Not found")
    }
    return successResponse({ withdrawn: true })
  } catch (error) {
    logger.error("Withdraw friend request error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to withdraw friend request")
  }
}
