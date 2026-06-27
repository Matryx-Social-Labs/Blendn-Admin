import { NextRequest } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import {
  successResponse,
  validationErrorResponse,
  unauthorizedResponse,
  notFoundResponse,
  serverErrorResponse,
} from "@/lib/api-response"

interface RouteParams {
  params: Promise<{ messageId: string }>
}

const reportMessageSchema = z.object({
  messageType: z.enum(["group", "private"]),
  reason: z.string().min(1, "Reason is required"),
  description: z.string().optional(),
})

// POST /api/mobile/messages/[messageId]/report — Report a chat or private message
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Authentication required")
    }

    const { messageId } = await params

    const body = await request.json()
    const validation = reportMessageSchema.safeParse(body)
    if (!validation.success) {
      return validationErrorResponse(validation.error)
    }

    const { messageType, reason, description } = validation.data

    const messageExists =
      messageType === "group"
        ? await db.chat_messages.findUnique({ where: { id: messageId }, select: { id: true } })
        : await db.private_messages.findUnique({ where: { id: messageId }, select: { id: true } })

    if (!messageExists) {
      return notFoundResponse("Message not found")
    }

    await db.message_reports.create({
      data: {
        reporter_id: authUser.userId,
        message_id: messageId,
        message_type: messageType,
        reason,
        description,
      },
    })

    return successResponse({ reported: true }, 201)
  } catch (error) {
    console.error("Report message error:", error)
    return serverErrorResponse("Failed to submit report")
  }
}
