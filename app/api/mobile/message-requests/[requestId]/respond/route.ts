import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { sendPushNotification } from "@/lib/push-notifications"
import {
  successResponse,
  unauthorizedResponse,
  validationErrorResponse,
  errorResponse,
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

    // If accepted, create a private conversation
    if (action === "accept") {
      const conversation = await db.private_conversations.create({
        data: {
          user1_id: messageRequest.sender_id,
          user2_id: authUser.userId,
        },
      })
      conversationId = conversation.id
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
      }).catch(() => {})
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
