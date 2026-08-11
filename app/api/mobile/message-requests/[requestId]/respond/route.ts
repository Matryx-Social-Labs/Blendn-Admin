import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { z } from "zod"
import { ConversationClosedError, openConversation } from "@/lib/conversations"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { sendPushNotification } from "@/lib/push-notifications"
import {
  successResponse,
  unauthorizedResponse,
  validationErrorResponse,
  errorResponse,
  conflictResponse,
  notFoundResponse,
  serverErrorResponse,
} from "@/lib/api-response"

interface RouteParams {
  params: Promise<{ requestId: string }>
}

const respondSchema = z.object({
  action: z.enum(["accept", "decline", "block"]),
})

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    const limited = await rateLimit(request, userLimit("write", "message-request-respond", authUser.userId))
    if (limited) return limited

    const { requestId } = await params

    // Validate requestId is a valid UUID
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (!uuidRegex.test(requestId)) {
      return errorResponse("Invalid request ID format", 400)
    }

    const body = await request.json()
    const parsed = respondSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }

    const { action } = parsed.data

    // Get the message request
    const messageRequest = await db.message_requests.findUnique({
      where: { id: requestId },
      include: {
        sender: {
          select: {
            id: true,
            name: true,
            image: true,
          },
        },
      },
    })

    if (!messageRequest) {
      return notFoundResponse("Message request not found")
    }

    // Verify the user is the recipient
    if (messageRequest.recipient_id !== authUser.userId) {
      return errorResponse("You can only respond to requests sent to you", 403)
    }

    // Verify the request is still pending
    if (messageRequest.status !== "pending") {
      return errorResponse(
        `This request has already been ${messageRequest.status}`
      )
    }

    const now = new Date()

    // Map action to status
    const statusMap = {
      accept: "accepted",
      decline: "declined",
      block: "blocked",
    } as const

    const newStatus = statusMap[action]

    // Update the message request
    await db.message_requests.update({
      where: { id: requestId },
      data: {
        status: newStatus,
        responded_at: now,
        updated_at: now,
      },
    })

    let conversationId: string | null = null

    // If accepted, create a private conversation.
    //
    // Through the shared helper, which sorts the pair. This used to write
    // (sender, recipient) in request order while POST /conversations wrote them
    // sorted — and `@@unique([user1_id, user2_id])` cannot tell that (a, b) and
    // (b, a) are the same two people, so one pair could end up with two rows.
    if (action === "accept") {
      try {
        const conversation = await openConversation(messageRequest.sender_id, authUser.userId)
        conversationId = conversation.id
      } catch (e) {
        // These two left each other before. Accepting a request cannot undo
        // that -- leaving is permanent -- and silently handing back the closed
        // row would give both sides a thread that is invisible in their inbox
        // and refuses every message.
        if (e instanceof ConversationClosedError) {
          return conflictResponse("This conversation was closed and cannot be reopened")
        }
        throw e
      }
    }

    /*
     * "Block" has to actually block.
     *
     * This set the request's status to `blocked` and stopped there, writing no
     * `blocked_users` row — so the only thing enforcing blocks anywhere saw
     * nothing, and the sender could simply send again. The status was a label on
     * a request; the block is a fact about two people.
     *
     * Idempotent: blocking someone who is already blocked is not an error.
     */
    if (action === "block") {
      await db.blocked_users.upsert({
        where: {
          blocker_id_blocked_id: {
            blocker_id: authUser.userId,
            blocked_id: messageRequest.sender_id,
          },
        },
        create: { blocker_id: authUser.userId, blocked_id: messageRequest.sender_id },
        update: {},
      })
    }

    // Notify the original sender of the response (async, don't await)
    if (action === "accept" || action === "decline") {
      // We need the responder's name — fetch it
      const responder = await db.user.findUnique({
        where: { id: authUser.userId },
        select: { name: true },
      })
      const responderName = responder?.name || "Someone"

      sendPushNotification({
        userId: messageRequest.sender_id,
        title: action === "accept" ? "Message request accepted 🎉" : "Message request declined",
        body: action === "accept"
          ? `${responderName} accepted your message request`
          : `${responderName} declined your message request`,
        data: {
          type: "message_request_response",
          requestId,
          conversationId: conversationId ?? undefined,
        },
        channelId: "messages",
      }).catch((err: unknown) =>
      // Push is best-effort and must not fail the request, but swallowing the
      // error entirely means a broken push pipeline is invisible.
      logger.warn("Push notification failed", {
        context: "message request response",
        error: err instanceof Error ? err.message : String(err),
      })
    )
    }

    return successResponse({
      success: true,
      status: newStatus,
      conversationId,
      sender: {
        id: messageRequest.sender.id,
        name: messageRequest.sender.name,
        avatar: messageRequest.sender.image,
      },
    })
  } catch (error) {
    logger.error("Respond to message request error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to respond to message request")
  }
}
