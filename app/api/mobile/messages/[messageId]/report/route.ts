import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
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

    const limited = await rateLimit(request, userLimit("safety", "report-message", authUser.userId))
    if (limited) return limited

    const { messageId } = await params

    const body = await request.json()
    const validation = reportMessageSchema.safeParse(body)
    if (!validation.success) {
      return validationErrorResponse(validation.error)
    }

    const { messageType, reason, description } = validation.data

    /*
     * You may only report a message you could actually see.
     *
     * This checked existence and nothing else, so any authenticated caller who
     * knew (or guessed) a message id could file a report against it -- against
     * a DM between two strangers, or a room they had never been in. Bundling
     * report into the leaving action puts more weight on this route, so it gets
     * the check that should always have been here.
     *
     * `notFound` for both "no such message" and "not yours to report": a
     * distinct 403 would confirm that a given id exists, which is exactly the
     * probe this is closing.
     */
    const visible =
      messageType === "group"
        ? await db.chat_messages.findFirst({
            where: {
              id: messageId,
              chat_group: { members: { some: { user_id: authUser.userId } } },
            },
            select: { id: true },
          })
        : await db.private_messages.findFirst({
            where: {
              id: messageId,
              conversation: {
                OR: [{ user1_id: authUser.userId }, { user2_id: authUser.userId }],
              },
            },
            select: { id: true },
          })

    if (!visible) {
      return notFoundResponse("Message not found")
    }

    await db.message_reports.create({
      data: {
        reporter_id: authUser.userId,
        message_id: messageId,
        message_type: messageType,
        reason,
        // Optional in the schema, so `undefined` when the phone omits it — and
        // the client always omits it. strictUndefinedChecks refused the write,
        // so no report from the app ever landed.
        ...(description !== undefined && { description }),
      },
    })

    return successResponse({ reported: true }, 201)
  } catch (error) {
    logger.error("Report message error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to submit report")
  }
}
