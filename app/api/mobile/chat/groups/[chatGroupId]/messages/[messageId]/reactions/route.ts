import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { mayWriteToRoom } from "@/lib/chat-window"
import { emitChatReaction } from "@/lib/socket-server"
import {
  ALLOWED_REACTIONS,
  isAllowedReaction,
  publicTally,
  tallyReactions,
} from "@/lib/reactions"
import {
  successResponse,
  errorResponse,
  validationErrorResponse,
  unauthorizedResponse,
  forbiddenResponse,
  notFoundResponse,
  serverErrorResponse,
} from "@/lib/api-response"

interface RouteParams {
  params: Promise<{ chatGroupId: string; messageId: string }>
}

/**
 * React to a message.
 *
 * `message_reactions` had a table, a unique index, a socket emitter, a client
 * bubble and a test — and **no writer**. Both read paths already tallied it, so
 * every message in the product shipped `reactions: []` for ever.
 *
 * One toggling endpoint rather than POST-to-add and DELETE-to-remove. A tap is
 * a toggle on the client, and splitting it puts the client in charge of knowing
 * which state it is in — which it gets wrong exactly when two devices disagree,
 * and the recovery is a duplicate-key error or a silent no-op depending on
 * which way round it guessed.
 *
 * Gated by `mayWriteToRoom`, the same rule the two message write paths use. A
 * reaction is participation: somebody muted for what they posted should not be
 * able to keep posting a smaller version of it, and a banned member should not
 * be reachable through a side door in a room they were removed from.
 */
const reactSchema = z.object({
  emoji: z.string().refine(isAllowedReaction, {
    message: `Emoji must be one of: ${ALLOWED_REACTIONS.join(" ")}`,
  }),
})

// POST /api/mobile/chat/groups/[chatGroupId]/messages/[messageId]/reactions
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) return unauthorizedResponse("Authentication required")

    const limited = await rateLimit(request, userLimit("write", "react", user.userId))
    if (limited) return limited

    const { chatGroupId, messageId } = await params

    const body = await request.json()
    const validation = reactSchema.safeParse(body)
    if (!validation.success) return validationErrorResponse(validation.error)
    const { emoji } = validation.data

    const chatGroup = await db.chat_groups.findUnique({
      where: { id: chatGroupId },
      select: {
        id: true,
        status: true,
        members: { where: { user_id: user.userId }, select: { status: true } },
        // Spread of both bounds, not just `end_time`: `chatWindowState` reads a
        // missing start as "no lower bound", which would open a room that has
        // not opened yet.
        event: { select: { start_time: true, end_time: true } },
      },
    })
    if (!chatGroup) return notFoundResponse("Chat group not found")

    const membership = chatGroup.members[0]
    if (!membership) return forbiddenResponse("You are not a member of this chat group")

    const denial = mayWriteToRoom(membership, chatGroup.event, chatGroup)
    if (denial) {
      return errorResponse(
        denial.reason === "banned"
          ? "You have been removed from this chat group"
          : denial.reason === "muted"
            ? "You are muted in this chat group"
            : "This room is not open",
        403
      )
    }

    /*
     * The message has to be in THIS group. Without the join a message id from
     * any room could be reacted to by anyone who is a member of any other room
     * — the message id is the only thing the caller supplies, and it is not a
     * secret.
     */
    const message = await db.chat_messages.findFirst({
      where: { id: messageId, chat_group_id: chatGroupId, deleted_at: null },
      select: { id: true },
    })
    if (!message) return notFoundResponse("Message not found")

    /*
     * Toggle, and let the unique index decide. A `findFirst` then branch would
     * be two round trips with a race between them: the same person
     * double-tapping on two devices lands both requests in the "does not exist"
     * branch and one of them dies on the constraint.
     */
    const existing = await db.message_reactions.deleteMany({
      where: { message_id: messageId, user_id: user.userId, emoji },
    })
    const added = existing.count === 0
    if (added) {
      await db.message_reactions.create({
        data: { message_id: messageId, user_id: user.userId, emoji },
      })
    }

    const reactions = await db.message_reactions.findMany({
      where: { message_id: messageId },
      select: { emoji: true, user_id: true },
    })

    // Counts to the room, counts-and-mine to the caller.
    emitChatReaction(chatGroupId, messageId, publicTally(reactions))

    return successResponse({
      messageId,
      added,
      reactions: tallyReactions(reactions, user.userId),
    })
  } catch (error) {
    logger.error("React to message error", {
      error: error instanceof Error ? error.message : String(error),
    })
    return serverErrorResponse("Failed to react")
  }
}
