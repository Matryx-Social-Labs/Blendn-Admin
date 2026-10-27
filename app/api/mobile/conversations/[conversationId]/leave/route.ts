import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { overUserLimit, rateLimit, userLimit } from "@/lib/rate-limit"
import { closeConversationRoom } from "@/lib/socket-server"
import { evictBlockedFromBlends } from "@/lib/crews/like"
import {
  successResponse,
  validationErrorResponse,
  unauthorizedResponse,
  forbiddenResponse,
  notFoundResponse,
  serverErrorResponse,
  errorResponse,
} from "@/lib/api-response"
import { isUuid, readOptionalJson, REPORT_REASON_MAX, REPORT_DESCRIPTION_MAX } from "@/lib/api-input"
import { leaveConversationIn } from "@/lib/leave-conversation"
import { notifyFriendshipChanged } from "@/lib/room-friends"

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
      reason: z.string().min(1, "Reason is required").max(REPORT_REASON_MAX),
      description: z.string().max(REPORT_DESCRIPTION_MAX).optional(),
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
    if (!isUuid(conversationId)) return errorResponse("Invalid conversation ID format", 400)

    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    const limited = await rateLimit(
      request,
      userLimit("safety", "conversation-leave", authUser.userId)
    )
    if (limited) return limited

    const parsed = leaveSchema.safeParse(await readOptionalJson(request))
    if (!parsed.success) return validationErrorResponse(parsed.error)
    const { action } = parsed.data

    /*
     * Over the daily report allowance (API M8), the leave and the block still
     * happen and only the report is dropped, said in `reportAccepted: false`:
     * a cap must never stand between somebody and a block.
     */
    const reportDropped = Boolean(parsed.data.report) && (await overUserLimit("reportDay", "report-conversation-day", authUser.userId))
    const report = reportDropped ? undefined : parsed.data.report

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
      await leaveConversationIn(tx, { conversationId, userId: authUser.userId, otherId, action })

      if (report) {
        if (report.messageId) {
          await tx.message_reports.create({
            data: {
              reporter_id: authUser.userId,
              message_id: report.messageId,
              message_type: "private",
              reason: report.reason,
              // Optional, and the sheet sends `{ reason: "other" }` alone — so
              // "Block and report" and "Unmatch and report" both 500'd and the
              // whole transaction rolled back: no block, no report, thread
              // still open. Driven on iOS. Tenth strictUndefinedChecks outage.
              ...(report.description !== undefined && { description: report.description }),
            },
          })
        } else {
          await tx.user_reports.create({
            data: {
              reporter_id: authUser.userId,
              reported_id: otherId,
              reason: report.reason,
              ...(report.description !== undefined && { description: report.description }),
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
    if (action === "block") void notifyFriendshipChanged(authUser.userId, otherId)
    // Either way the pair is kept apart now (a closed conversation is a block
    // on every crew surface, C6): out of any Blend room that now refuses them;
    // the Blend goes on for everyone else (D-9).
    await evictBlockedFromBlends(authUser.userId, otherId)

    return successResponse({
      closed: true,
      blocked: action === "block",
      reported: Boolean(report),
      // False only when a report was sent and the daily allowance had run out.
      reportAccepted: !reportDropped,
    })
  } catch (error) {
    logger.error("Leave conversation error", {
      error: error instanceof Error ? error.message : String(error),
    })
    return serverErrorResponse("Failed to leave conversation")
  }
}
