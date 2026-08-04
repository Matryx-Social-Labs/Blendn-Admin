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
  conflictResponse,
  serverErrorResponse,
} from "@/lib/api-response"

const createRequestSchema = z.object({
  // User ids are cuid, not uuid — do not tighten this to z.string().uuid().
  recipientId: z.string().min(1),
  message: z.string().trim().min(1).max(500).optional(),
})

// POST: Create a message request
export async function POST(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    const body = await request.json()
    const parsed = createRequestSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }

    const { recipientId, message } = parsed.data

    // Cannot send request to yourself
    if (recipientId === authUser.userId) {
      return errorResponse("Cannot send a message request to yourself")
    }

    // Check if recipient exists
    const recipient = await db.user.findUnique({
      where: { id: recipientId },
      select: { id: true, name: true },
    })

    if (!recipient) {
      return notFoundResponse("User not found")
    }

    // Check if either user has blocked the other
    const blockExists = await db.blocked_users.findFirst({
      where: {
        OR: [
          { blocker_id: authUser.userId, blocked_id: recipientId },
          { blocker_id: recipientId, blocked_id: authUser.userId },
        ],
      },
      select: { blocker_id: true },
    })

    if (blockExists) {
      // Return generic not-found to avoid leaking block status to the sender
      return notFoundResponse("User not found")
    }

    // Check if a request already exists between these users (in either direction)
    const existingRequest = await db.message_requests.findFirst({
      where: {
        OR: [
          { sender_id: authUser.userId, recipient_id: recipientId },
          { sender_id: recipientId, recipient_id: authUser.userId },
        ],
      },
    })

    if (existingRequest) {
      if (existingRequest.sender_id === authUser.userId) {
        return conflictResponse("You have already sent a request to this user")
      } else {
        return conflictResponse(
          "This user has already sent you a request. Check your incoming requests."
        )
      }
    }

    // Check if a conversation already exists between these users
    const existingConversation = await db.private_conversations.findFirst({
      where: {
        OR: [
          { user1_id: authUser.userId, user2_id: recipientId },
          { user1_id: recipientId, user2_id: authUser.userId },
        ],
      },
    })

    if (existingConversation) {
      return conflictResponse("You already have a conversation with this user")
    }

    // Fetch sender name for push notification (authUser doesn't carry name)
    const sender = await db.user.findUnique({
      where: { id: authUser.userId },
      select: { name: true },
    })
    const senderName = sender?.name || "Someone"

    // Create the message request
    const messageRequest = await db.message_requests.create({
      data: {
        sender_id: authUser.userId,
        recipient_id: recipientId,
        message,
        status: "pending",
      },
      include: {
        recipient: {
          select: {
            id: true,
            name: true,
            image: true,
          },
        },
      },
    })

    // Notify recipient of new message request (async, don't await)
    sendPushNotification({
      userId: recipientId,
      title: "New message request",
      // Deliberately generic: push bodies render on a locked screen, so the
      // request text stays in the app rather than on the lock screen.
      body: `${senderName} wants to connect`,
      data: { type: "message_request", requestId: messageRequest.id },
      channelId: "messages",
    }).catch((err: unknown) =>
      // Push is best-effort and must not fail the request, but swallowing the
      // error entirely means a broken push pipeline is invisible.
      logger.warn("Push notification failed", {
        context: "message request",
        error: err instanceof Error ? err.message : String(err),
      })
    )

    return successResponse(
      {
        request: {
          id: messageRequest.id,
          recipientId: messageRequest.recipient_id,
          recipient: {
            id: messageRequest.recipient.id,
            name: messageRequest.recipient.name,
            avatar: messageRequest.recipient.image,
          },
          message: messageRequest.message,
          status: messageRequest.status,
          createdAt: messageRequest.created_at,
        },
      },
      201
    )
  } catch (error) {
    logger.error("Create message request error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to create message request")
  }
}

// GET: List incoming message requests
export async function GET(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    const searchParams = request.nextUrl.searchParams
    const status = searchParams.get("status") || "pending"
    const limit = Math.min(parseInt(searchParams.get("limit") || "20"), 50)
    const offset = parseInt(searchParams.get("offset") || "0")

    // Validate status
    const validStatuses = ["pending", "accepted", "declined", "blocked"]
    if (!validStatuses.includes(status)) {
      return errorResponse("Invalid status filter")
    }

    // Get total count
    const totalCount = await db.message_requests.count({
      where: {
        recipient_id: authUser.userId,
        status: status as "pending" | "accepted" | "declined" | "blocked",
      },
    })

    // Fetch incoming message requests
    const requests = await db.message_requests.findMany({
      where: {
        recipient_id: authUser.userId,
        status: status as "pending" | "accepted" | "declined" | "blocked",
      },
      include: {
        sender: {
          select: {
            id: true,
            name: true,
            image: true,
          },
        },
      },
      orderBy: { created_at: "desc" },
      skip: offset,
      take: limit,
    })

    return successResponse({
      requests: requests.map((r) => ({
        id: r.id,
        senderId: r.sender_id,
        sender: {
          id: r.sender.id,
          name: r.sender.name,
          avatar: r.sender.image,
        },
        message: r.message,
        status: r.status,
        createdAt: r.created_at,
      })),
      totalCount,
    })
  } catch (error) {
    logger.error("Get message requests error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to get message requests")
  }
}
