import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { z } from "zod"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { blockCounterparties } from "@/lib/conversations"
import { db } from "@/lib/db"
import { emitChatMessage } from "@/lib/socket-server"
import { notifyGroupMessage } from "@/lib/push-notifications"
import { rateLimit } from "@/lib/rate-limit"
import { moderateMessage, checkSpam } from "@/lib/moderation"
import { checkAndAutoUnmute, hideMessage, flagForReview, checkAndAutoMute } from "@/lib/moderation/actions"
import { checkKeywords } from "@/lib/moderation/keyword-filter"
import { checkContactInfo } from "@/lib/moderation/contact-info"
import { checkTextContent } from "@/lib/moderation/openai-moderation"
import {
  successResponse,
  errorResponse,
  unauthorizedResponse,
  forbiddenResponse,
  notFoundResponse,
  validationErrorResponse,
  serverErrorResponse,
  ErrorCode,
} from "@/lib/api-response"
import { chatClosedMessage, mayWriteToRoom } from "@/lib/chat-window"

const sendMessageSchema = z.object({
  content: z.string().min(1, "Message content is required").max(4000),
  type: z.enum(["text", "image", "video"]).default("text"),
  metadata: z.record(z.string(), z.any()).optional(),
  parentId: z.string().uuid().optional(),
})

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ chatGroupId: string }> }
) {
  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return unauthorizedResponse("Authentication required")
    }

    const { chatGroupId } = await params
    const { searchParams } = new URL(request.url)

    // Validate chatGroupId is a valid UUID
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (!uuidRegex.test(chatGroupId)) {
      return errorResponse("Invalid chat group ID format", 400)
    }

    // Pagination params
    const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 100)
    const before = searchParams.get("before") // cursor for pagination

    // Check if chat group exists and user is a member
    const chatGroup = await db.chat_groups.findUnique({
      where: { id: chatGroupId },
      include: {
        members: {
          where: { user_id: user.userId },
        },
      },
    })

    if (!chatGroup) {
      return notFoundResponse("Chat group not found")
    }

    // Check if user is a member
    const isMember = chatGroup.members.length > 0
    if (!isMember) {
      return forbiddenResponse("You are not a member of this chat group")
    }

    // Build anonymous name map
    const allMembers = await db.chat_group_members.findMany({
      where: { chat_group_id: chatGroupId },
      select: { user_id: true, anonymous_name: true },
    })
    const anonMap = new Map(
      allMembers.map((m) => [m.user_id, m.anonymous_name || "Attendee"])
    )

    // Build query for messages — include moderation-hidden messages
    // so the sender can see "This message was removed" placeholders
    /*
     * A blocked person's messages do not appear in the room.
     *
     * `blocked_users` had never been consulted anywhere in group chat, so
     * blocking someone removed your ability to DM them and nothing else --
     * their messages still arrived in the history, over the socket and as a
     * push notification.
     */
    const blockedIds = await blockCounterparties(user.userId)

    const whereClause: Record<string, unknown> = {
      chat_group_id: chatGroupId,
      ...(blockedIds.length ? { user_id: { notIn: blockedIds } } : {}),
      OR: [
        { deleted_at: null },
        { moderation_status: "hidden", user_id: user.userId },
      ],
    }

    // If cursor provided, get messages before that message
    if (before) {
      const cursorMessage = await db.chat_messages.findUnique({
        where: { id: before },
        select: { created_at: true },
      })

      if (cursorMessage) {
        whereClause.created_at = { lt: cursorMessage.created_at }
      }
    }

    // Fetch messages
    const messages = await db.chat_messages.findMany({
      where: whereClause,
      include: {
        user: {
          select: {
            id: true,
            name: true,
            image: true,
          },
        },
        reactions: {
          select: {
            id: true,
            emoji: true,
            user_id: true,
          },
        },
        parent_message: {
          select: {
            id: true,
            content: true,
            user: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
        _count: {
          select: {
            replies: true,
          },
        },
      },
      orderBy: { created_at: "desc" },
      take: limit + 1, // Fetch one extra to check if there are more
    })

    // Check if there are more messages
    const hasMore = messages.length > limit
    const messagesToReturn = hasMore ? messages.slice(0, limit) : messages

    // Reverse to get chronological order (oldest first within the batch)
    messagesToReturn.reverse()

    return successResponse({
      messages: messagesToReturn.map((m) => {
        const isHidden = m.moderation_status === "hidden"
        return {
          ...m,
          // Redact content for moderation-hidden messages; show placeholder
          content: isHidden ? null : m.content,
          moderation_hidden: isHidden,
          user: {
            id: m.user.id,
            name: anonMap.get(m.user.id) || "Attendee",
            image: null,
          },
          parent_message: m.parent_message
            ? {
                ...m.parent_message,
                user: {
                  id: m.parent_message.user.id,
                  name: anonMap.get(m.parent_message.user.id) || "Attendee",
                },
              }
            : null,
        }
      }),
      pagination: {
        hasMore,
        nextCursor: hasMore ? messagesToReturn[0]?.id : null,
      },
    })
  } catch (error) {
    logger.error("Get chat messages error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to get messages")
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ chatGroupId: string }> }
) {
  // Rate limit: max 30 messages per user per minute per group
  const rateLimited = await rateLimit(request, {
    windowMs: 60 * 1000,
    maxRequests: 30,
    keyGenerator: (req) => {
      const auth = req.headers.get("authorization") || "anon"
      const url = req.nextUrl.pathname
      return `groupmsg:${auth.slice(-16)}:${url}`
    },
  })
  if (rateLimited) return rateLimited

  try {
    const user = await getAuthenticatedUser(request)
    if (!user) {
      return unauthorizedResponse("Authentication required")
    }

    const { chatGroupId } = await params

    // Validate chatGroupId is a valid UUID
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (!uuidRegex.test(chatGroupId)) {
      return errorResponse("Invalid chat group ID format", 400)
    }

    const body = await request.json()

    // Validate request body
    const validation = sendMessageSchema.safeParse(body)
    if (!validation.success) {
      return validationErrorResponse(validation.error)
    }

    const { content, type, metadata, parentId } = validation.data

    // Check if chat group exists and user is a member
    const chatGroup = await db.chat_groups.findUnique({
      where: { id: chatGroupId },
      include: {
        members: {
          where: { user_id: user.userId },
        },
        // end_time decides the write window; without it this path had no idea
        // how long ago the event finished.
        // `start_time` joins it now that the room also has a floor. Selecting
        // only `end_time` would leave this path silently un-floored --
        // `chatWindowState` treats a missing start as "no lower bound", which
        // is the right default for old callers and the wrong one here.
        event: { select: { start_time: true, end_time: true } },
      },
    })

    if (!chatGroup) {
      return notFoundResponse("Chat group not found")
    }

    // Check if user is a member
    const membership = chatGroup.members[0]
    if (!membership) {
      return forbiddenResponse("You are not a member of this chat group")
    }

    // Check if user is muted or banned
    let effectiveStatus: string = membership.status
    if (membership.status === "muted") {
      // Check if the auto-mute window has expired (1 hour)
      const wasUnmuted = await checkAndAutoUnmute(user.userId, chatGroupId)
      if (wasUnmuted) effectiveStatus = "active"
      if (!wasUnmuted) {
        return errorResponse(
          "You are muted in this chat group. Your messages have been flagged for policy violations.",
          403,
          ErrorCode.USER_MUTED
        )
      }
      // User was auto-unmuted, proceed with sending
    }
    /*
     * One rule for whether this member may write — shared with the other write
     * path. See `mayWriteToRoom`.
     *
     * The check-out cutoff that used to sit here is gone. It read
     * `last_allowed_at`, which check-out sets to `now`, so leaving the venue
     * revoked exactly the access the 24-hour window exists to grant. Membership
     * is an attendance record; attendance does not expire when you walk out of
     * the building.
     *
     * The mute is resolved first because auto-unmute is a side-effecting
     * recovery, not a predicate — `mayWriteToRoom` sees the status it leaves
     * behind.
     */
    const denial = mayWriteToRoom(
      { status: effectiveStatus },
      chatGroup.event,
      chatGroup
    )
    if (denial) {
      if (denial.reason === "banned") {
        return errorResponse(
          "You have been banned from this chat group due to repeated policy violations.",
          403,
          ErrorCode.USER_BANNED
        )
      }
      if (denial.reason === "muted") {
        return errorResponse(
          "You are muted in this chat group. Your messages have been flagged for policy violations.",
          403,
          ErrorCode.USER_MUTED
        )
      }
      return errorResponse(
        chatClosedMessage(denial.reason),
        403,
        denial.reason === "locked" ? ErrorCode.CHAT_LOCKED : ErrorCode.CHAT_CLOSED
      )
    }

    // If replying, verify parent message exists in this group
    if (parentId) {
      const parentMessage = await db.chat_messages.findFirst({
        where: {
          id: parentId,
          chat_group_id: chatGroupId,
          deleted_at: null,
        },
      })

      if (!parentMessage) {
        return errorResponse("Parent message not found", 400)
      }
    }

    // Spam check (sync — block before saving)
    const spamResult = checkSpam(user.userId, chatGroupId, content)
    if (spamResult && spamResult.action === "hide") {
      return errorResponse(
        spamResult.reason || "Message blocked as spam. Please slow down.",
        429,
        ErrorCode.SPAM_BLOCKED
      )
    }

    // --- Pre-save moderation: keyword filter (sync, <1ms) ---
    const keywordResult = checkKeywords(content)
    if (keywordResult && keywordResult.action === "hide") {
      // Save the message but immediately mark it as hidden
      const message = await db.chat_messages.create({
        data: {
          chat_group_id: chatGroupId,
          user_id: user.userId,
          content,
          type,
          metadata: metadata || undefined,
          parent_id: parentId || null,
          moderation_status: "hidden",
          deleted_at: new Date(),
        },
      })
      // Flag for review and check auto-mute (fire-and-forget)
      void flagForReview(message.id, chatGroupId, user.userId, keywordResult)
      void checkAndAutoMute(user.userId, chatGroupId)
      // Return success to sender but message is already hidden — never emitted to others
      return successResponse({
        id: message.id,
        type: message.type,
        content: null,
        moderation_hidden: true,
        createdAt: message.created_at.toISOString(),
      })
    }

    /*
     * Contact details — flagged, never blocked, and deliberately after the
     * hide gate above.
     *
     * The message is sent. This records that somebody handed out a number or a
     * handle in a pseudonymous room, so the pattern is visible to a moderator;
     * it does not refuse them. Refusing would teach the boundary in one message
     * and cost the visibility too -- the next attempt is spelled out, and now
     * there is no flag either.
     *
     * The client shows the warning *before* sending, from the same module, so
     * what a sender was told and what a moderator sees cannot disagree.
     */
    const contactResult = checkContactInfo(content)

    // Create the message
    const message = await db.chat_messages.create({
      data: {
        chat_group_id: chatGroupId,
        user_id: user.userId,
        content,
        type,
        metadata: metadata || undefined,
        parent_id: parentId || null,
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            image: true,
          },
        },
        parent_message: {
          select: {
            id: true,
            content: true,
            user: {
              select: {
                id: true,
                name: true,
              },
            },
          },
        },
      },
    })

    /*
     * Recorded here, not at the top, because a flag needs a message id -- and
     * recorded before any of the hide paths below can early-return, so a
     * message that is both hidden and full of contact details still carries
     * both signals into review.
     */
    if (contactResult) {
      void flagForReview(message.id, chatGroupId, user.userId, contactResult)
    }

    // --- Pre-emit moderation: OpenAI check with 1s timeout ---
    // Run OpenAI moderation before broadcasting. If it takes >1s, emit anyway
    // and fall back to the post-emit hide behavior for safety.
    if (type === "text") {
      try {
        /*
         * The loser of this race used to keep its timer alive: `Promise.race`
         * settles on the first result and abandons the rest, but a pending
         * `setTimeout` is a live handle the event loop still holds. One per
         * message, for a second each — harmless at rest, and exactly the kind of
         * thing that stops being harmless under load.
         */
        let timeoutHandle: NodeJS.Timeout | undefined
        const openaiResult = await Promise.race([
          checkTextContent(content),
          new Promise<null>((resolve) => {
            timeoutHandle = setTimeout(() => resolve(null), 1000)
          }),
        ]).finally(() => clearTimeout(timeoutHandle))
        if (openaiResult && openaiResult.action === "hide") {
          // Hide immediately — never broadcast to other users
          await hideMessage(message.id, chatGroupId, user.userId, openaiResult)
          await flagForReview(message.id, chatGroupId, user.userId, openaiResult)
          void checkAndAutoMute(user.userId, chatGroupId)
          return successResponse({
            id: message.id,
            type: message.type,
            content: null,
            moderation_hidden: true,
            createdAt: message.created_at.toISOString(),
          })
        }
        // If flagged (not hidden), let it through but flag for review
        if (openaiResult && openaiResult.action === "flag") {
          void flagForReview(message.id, chatGroupId, user.userId, openaiResult)
        }
        // If timeout (null) or clean, proceed to emit
        // For timeout case, fire-and-forget the full moderation pipeline as fallback
        if (!openaiResult && content.length > 5) {
          void moderateMessage(message.id, content, type, user.userId, chatGroupId)
        }
      } catch {
        // OpenAI failed — fall back to async moderation
        void moderateMessage(message.id, content, type, user.userId, chatGroupId)
      }
    } else {
      // For images/media, run full async moderation (can't block on image analysis)
      void moderateMessage(
        message.id,
        content,
        type,
        user.userId,
        chatGroupId,
        (metadata as Record<string, string> | undefined)?.mediaUrl
      )
    }

    // Mark as clean if we got past all checks
    if (!message.moderation_status || message.moderation_status === "pending") {
      void db.chat_messages.update({
        where: { id: message.id },
        data: { moderation_status: "clean" },
      }).catch((err: unknown) =>
      // Push is best-effort and must not fail the request, but swallowing the
      // error entirely means a broken push pipeline is invisible.
      logger.warn("Push notification failed", {
        context: "group chat message",
        error: err instanceof Error ? err.message : String(err),
      })
    )
    }

    // Update chat group's last_message_at
    await db.chat_groups.update({
      where: { id: chatGroupId },
      data: { last_message_at: new Date() },
    })

    // Use anonymous name for socket emit and push
    const senderAnonName = membership.anonymous_name || "Attendee"

    /*
     * Everyone in a block relationship with the sender, in either direction.
     *
     * Fetched once and used for all three delivery paths below -- the live
     * socket, and the push fan-out. The REST history above filters on the same
     * set, so the three surfaces cannot disagree about who is in the room.
     */
    const senderBlocked = await blockCounterparties(user.userId)

    // Emit real-time message — only reaches here if moderation passed
    emitChatMessage(
      chatGroupId,
      {
        id: message.id,
        content: message.content,
        type: message.type,
        userId: message.user_id,
        userName: senderAnonName,
        userImage: undefined,
        createdAt: message.created_at.toISOString(),
        parentId: message.parent_id || undefined,
      },
      senderBlocked
    )

    // Send push notifications to group members (async, don't await)
    db.chat_group_members
      .findMany({
        where: {
          chat_group_id: chatGroupId,
          status: "active",
          // A lock screen is the loudest surface in the product. Somebody who
          // blocked this sender must not get a notification from them.
          ...(senderBlocked.length ? { user_id: { notIn: senderBlocked } } : {}),
        },
        select: { user_id: true },
      })
      .then((members) => {
        const memberIds = members.map((m) => m.user_id)
        const groupName = chatGroup.name || "Group Chat"
        const messagePreview = type === "text" ? content : type === "image" ? "📷 Photo" : "🎥 Video"

        return notifyGroupMessage(memberIds, senderAnonName, groupName, messagePreview, chatGroupId, user.userId)
      })
      .catch((err) => logger.error("Push notification failed", { error: err instanceof Error ? err.message : String(err) }))

    // Return anonymized response
    return successResponse({
      ...message,
      user: {
        id: message.user.id,
        name: senderAnonName,
        image: null,
      },
      parent_message: message.parent_message
        ? {
            ...message.parent_message,
            user: {
              id: message.parent_message.user.id,
              name: membership.anonymous_name || "Attendee",
            },
          }
        : null,
    }, 201)
  } catch (error) {
    logger.error("Send message error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to send message")
  }
}
