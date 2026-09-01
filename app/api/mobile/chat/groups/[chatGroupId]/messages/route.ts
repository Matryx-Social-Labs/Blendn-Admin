import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { z } from "zod"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { blockCounterparties } from "@/lib/conversations"
import { db } from "@/lib/db"
import { tallyReactions } from "@/lib/reactions"
import { deliverToRoom, previewFor } from "@/lib/room-delivery"
import { rateLimit } from "@/lib/rate-limit"
import { moderateMessage, checkSpam } from "@/lib/moderation"
import { checkAndAutoUnmute, hideMessage, flagForReview, checkAndAutoMute } from "@/lib/moderation/actions"
import { checkKeywords } from "@/lib/moderation/keyword-filter"
import { checkTextContent, notChecked, type ModerationCheck } from "@/lib/moderation/openai-moderation"
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

    /*
     * The pseudonym map, scoped to this page rather than to the whole room.
     *
     * This used to load every `chat_group_members` row for the group before
     * the messages were even fetched — so a 500-person room paid 500 rows to
     * render 50 messages, and the cost grew with the room while the need did
     * not. The map has exactly two consumers, the sender and the quoted
     * message's author, and both are inside the page.
     *
     * Same answer, bounded by `limit`. Not a `take:` — a cap here would be
     * wrong rather than slow, because the members a cap dropped would render
     * as "Attendee" and that is the K3.2 misattribution bug, arriving by a
     * different route.
     */
    const pseudonymFor = new Set<string>()
    for (const m of messagesToReturn) {
      pseudonymFor.add(m.user.id)
      if (m.parent_message) pseudonymFor.add(m.parent_message.user.id)
    }
    const pageMembers = pseudonymFor.size
      ? await db.chat_group_members.findMany({
          where: { chat_group_id: chatGroupId, user_id: { in: [...pseudonymFor] } },
          select: { user_id: true, anonymous_name: true },
        })
      : []
    const anonMap = new Map(pageMembers.map((m) => [m.user_id, m.anonymous_name || "Attendee"]))

    return successResponse({
      messages: messagesToReturn.map((m) => {
        const isHidden = m.moderation_status === "hidden"
        return {
          ...m,
          /*
           * Counts, not names. The spread above carries `reactions` straight
           * out of the row — `{ id, emoji, user_id }` per reaction — so this
           * route disclosed exactly who reacted to what, to everybody in the
           * room. `docs/CHAT.md:119`: "reactions show the count only, never
           * who". Overridden here rather than narrowed in the `select`, because
           * `user_id` is what `mine` is computed from.
           */
          reactions: isHidden ? [] : tallyReactions(m.reactions, user.userId),
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
    const spamResult = await checkSpam(user.userId, chatGroupId, content)
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
     * Contact details are detected by `moderateMessage`, not here.
     *
     * This route used to run `checkContactInfo` itself, and
     * `events/[eventId]/chat` did not — so the event room, the surface this
     * product is actually about, never detected a phone number or a handle.
     * The check now lives in the pipeline, which both routes call and a third
     * one cannot forget.
     *
     * It flags rather than refusing. Taking a conversation off-platform is
     * where there is no block, no report and no record, so a moderator should
     * see the pattern — refusing would teach the sender the boundary and cost
     * the visibility, and the next attempt would be spelled out with no flag
     * behind it. The client shows its warning before sending, from the same
     * module, so what a sender was told and what a moderator sees agree.
     */
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
    /*
     * Did anybody actually look at this message?
     *
     * Only the inline text check can answer yes. Media goes to the async
     * pipeline, which records its own outcome, and so does anything the inline
     * check failed to examine -- so `clean` is written here only when this
     * request examined the content itself and found nothing.
     */
    let examinedInline = false

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
        /*
         * The timeout is a *reason*, not a verdict.
         *
         * This resolved to `null`, which was the same value the check returns
         * for clean content -- and for a missing API key, and for an API error.
         * Four facts in one value, and the code below then wrote
         * `moderation_status: "clean"` for all of them.
         */
        const openaiCheck = await Promise.race([
          checkTextContent(content),
          new Promise<ModerationCheck>((resolve) => {
            timeoutHandle = setTimeout(() => resolve(notChecked("timeout")), 1000)
          }),
        ]).finally(() => clearTimeout(timeoutHandle))
        examinedInline = openaiCheck.checked
        const openaiResult = openaiCheck.checked ? openaiCheck.result : null
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
        /*
         * Anything the inline check did not examine goes to the full pipeline,
         * which owns the verdict and will record `unchecked` if it cannot get
         * one either.
         *
         * The `content.length > 5` guard is gone. It meant a short message that
         * timed out was examined by nobody and then recorded as clean, and short
         * messages are not a category that needs less moderation -- a slur is
         * five characters.
         */
        if (!openaiCheck.checked) {
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

    /*
     * Clean means somebody looked and found nothing.
     *
     * This wrote `clean` unconditionally -- including when the block above had
     * just handed the message to the async pipeline because the model was
     * unreachable or timed out. So the inline write RACED the pipeline's
     * verdict, and being the later write it could overwrite a `flagged` with a
     * `clean`.
     *
     * Now it only claims the verdict it actually has. Everything else is the
     * pipeline's to record, including `unchecked`.
     */
    if (
      examinedInline &&
      (!message.moderation_status || message.moderation_status === "pending")
    ) {
      void db.chat_messages
        .update({
          where: { id: message.id },
          data: { moderation_status: "clean" },
        })
        .catch((err: unknown) =>
          // Best-effort: a failure here leaves the message pending for the
          // sweeper rather than failing the send.
          logger.warn("Failed to record moderation outcome", {
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
     * Socket then push, block-filtered, in `lib/room-delivery.ts`.
     *
     * Shared with the event-chat POST, which persisted a message and stopped --
     * no emit, no push -- so a message sent from that screen was invisible to
     * anyone who already had the room open. Two write paths into one table, and
     * only one of them delivered.
     *
     * Awaited rather than fire-and-forget: it never throws, and awaiting means
     * the sender's 200 is not ahead of the room's copy.
     */
    await deliverToRoom({
      chatGroupId,
      groupName: chatGroup.name,
      senderId: user.userId,
      senderAnonName,
      message,
      preview: previewFor(type, content),
    })

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
