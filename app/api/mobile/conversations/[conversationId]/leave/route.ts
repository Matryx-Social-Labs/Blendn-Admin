import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { closeConversationRoom } from "@/lib/socket-server"
import {
  successResponse,
  validationErrorResponse,
  unauthorizedResponse,
  forbiddenResponse,
  notFoundResponse,
  serverErrorResponse,
} from "@/lib/api-response"

interface RouteParams {
  params: Promise<{ conversationId: string }>
}

/**
 * Leaving, and reporting, in one call.
 *
 * `DELETE /conversations/:id` already closes a conversation, and the two report
 * routes already exist. Composing them on the client is what this replaces, and
 * the reason is not tidiness: a partial failure lands on exactly the state this
 * whole design exists to prevent. Close succeeds and report fails, and the
 * evidence is out of reach behind a thread that has left both inboxes. Report
 * succeeds and close fails, and the person who wanted out is still in it.
 *
 * One transaction, so the safest-feeling act and the evidence-preserving act
 * are the same tap.
 *
 * ```
 *   POST /conversations/:id/leave
 *          │
 *          ├─ close the conversation            ─┐
 *          ├─ block, if asked                    ├─ one transaction
 *          └─ file the report, if given         ─┘
 *          │
 *          └─ evict both sides from the socket room   (after; not rollback-able,
 *                                                      and harmless if repeated)
 * ```
 *
 * The report is optional because most leaving is not a complaint — "we didn't
 * click" is the common case and must stay cheap.
 */
const leaveSchema = z.object({
  /**
   * `unmatch` closes the connection; `block` closes the encounter and also
   * hides them from your event rooms. Both are permanent as far as the match is
   * concerned — unblocking never restores it.
   */
  action: z.enum(["unmatch", "block"]).default("unmatch"),
  report: z
    .object({
      reason: z.string().min(1, "Reason is required"),
      description: z.string().max(2000).optional(),
      /**
       * A specific message, when there is one worth pointing at. Without it the
       * report is filed against the person instead — which is also what stays
       * available later, since `user_reports` needs no conversation.
       */
      messageId: z.string().uuid().optional(),
    })
    .optional(),
})

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { conversationId } = await params

    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    const limited = await rateLimit(
      request,
      userLimit("safety", "conversation-leave", authUser.userId)
    )
    if (limited) return limited

    const parsed = leaveSchema.safeParse(await request.json().catch(() => ({})))
    if (!parsed.success) return validationErrorResponse(parsed.error)
    const { action, report } = parsed.data

    const conversation = await db.private_conversations.findUnique({
      where: { id: conversationId },
      select: { id: true, user1_id: true, user2_id: true, closed_at: true },
    })
    if (!conversation) return notFoundResponse("Conversation not found")

    if (
      conversation.user1_id !== authUser.userId &&
      conversation.user2_id !== authUser.userId
    ) {
      return forbiddenResponse("Not authorized to leave this conversation")
    }

    const otherId =
      conversation.user1_id === authUser.userId
        ? conversation.user2_id
        : conversation.user1_id

    /*
     * The message has to belong to this conversation.
     *
     * Otherwise the leave route becomes a way to file a report against any
     * message id you can name, which is the hole the standalone report route
     * had. Checked before the transaction so a bad id is a 404 rather than a
     * rolled-back close.
     */
    if (report?.messageId) {
      const belongs = await db.private_messages.findFirst({
        where: { id: report.messageId, conversation_id: conversationId },
        select: { id: true },
      })
      if (!belongs) return notFoundResponse("Message not found")
    }

    await db.$transaction(async (tx) => {
      // Idempotent, and scoped by `closed_at: null` so a retry never rewrites
      // who left or when.
      await tx.private_conversations.updateMany({
        where: { id: conversationId, closed_at: null },
        data: { closed_at: new Date(), closed_by: authUser.userId, closed_reason: action },
      })

      if (action === "block") {
        await tx.blocked_users.upsert({
          where: {
            blocker_id_blocked_id: { blocker_id: authUser.userId, blocked_id: otherId },
          },
          create: { blocker_id: authUser.userId, blocked_id: otherId },
          update: {},
        })
        // Both directions: a request either of them left pending must not
        // survive to be accepted into a conversation between blocked people.
        await tx.message_requests.updateMany({
          where: {
            status: "pending",
            OR: [
              { sender_id: otherId, recipient_id: authUser.userId },
              { sender_id: authUser.userId, recipient_id: otherId },
            ],
          },
          data: { status: "blocked" },
        })
      }

      if (report) {
        if (report.messageId) {
          await tx.message_reports.create({
            data: {
              reporter_id: authUser.userId,
              message_id: report.messageId,
              message_type: "private",
              reason: report.reason,
              description: report.description,
            },
          })
        } else {
          await tx.user_reports.create({
            data: {
              reporter_id: authUser.userId,
              reported_id: otherId,
              reason: report.reason,
              description: report.description,
            },
          })
        }
      }
    })

    /*
     * Outside the transaction, deliberately.
     *
     * A socket room is not transactional and cannot be rolled back, so doing it
     * inside would mean a late failure left people evicted from a conversation
     * that is still open. Repeating it is harmless.
     */
    closeConversationRoom(conversationId)

    return successResponse({
      closed: true,
      blocked: action === "block",
      reported: Boolean(report),
    })
  } catch (error) {
    logger.error("Leave conversation error", {
      error: error instanceof Error ? error.message : String(error),
    })
    return serverErrorResponse("Failed to leave conversation")
  }
}
