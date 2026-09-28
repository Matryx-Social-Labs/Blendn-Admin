import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { ConversationClosedError, blockedEitherWay, openConversation } from "@/lib/conversations"
import { participationRefusal } from "@/lib/event-access"
import { areFriends } from "@/lib/friends"
import { userIdFromRefIfIdentified } from "@/lib/identity"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import {
  successResponse,
  unauthorizedResponse,
  notFoundResponse,
  forbiddenResponse,
  conflictResponse,
  serverErrorResponse,
} from "@/lib/api-response"

/**
 * POST /api/mobile/friends/:userId/conversation — open (or find) a DM with a
 * friend. No shared event needed: being friends is the consent a message
 * request otherwise stands in for.
 *
 * Marked `origin_friendship`, so the DM does not make the pair recognisable to
 * each other in rooms. An existing conversation is returned as it is — a pair
 * who matched and then became friends keep the conversation they had.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const me = authUser.userId

    const limited = await rateLimit(request, userLimit("write", "friend-conversation", me))
    if (limited) return limited

    const unfinished = await participationRefusal(me)
    if (unfinished) return forbiddenResponse(unfinished)

    // As `GET /friends/:id`: a handle only for a friend you can recognise.
    const userId = await userIdFromRefIfIdentified(me, (await params).userId)
    // A block severs the friendship, so the second check is belt and braces
    // for a request racing the block.
    if (!(await areFriends(me, userId)) || (await blockedEitherWay(me, userId))) {
      return notFoundResponse("Not found")
    }

    try {
      const conversation = await openConversation(me, userId, { friendship: true })
      return successResponse({ conversationId: conversation.id })
    } catch (error) {
      if (error instanceof ConversationClosedError) {
        return conflictResponse("This conversation was closed and cannot be reopened")
      }
      throw error
    }
  } catch (error) {
    logger.error("Open friend conversation error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to open conversation")
  }
}
