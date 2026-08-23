import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { Prisma } from "@prisma/client"
import { blockCounterparties } from "@/lib/conversations"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import {
  successResponse,
  errorResponse,
  validationErrorResponse,
  unauthorizedResponse,
  notFoundResponse,
  forbiddenResponse,
  serverErrorResponse,
  ErrorCode,
} from "@/lib/api-response"
import {
  chatClosesAt,
  chatClosedMessage,
  chatWindowState,
  entitlementAdmits,
  mayWriteToRoom,
  roomEntitlement,
  type RoomEntitlement,
} from "@/lib/chat-window"
import { chatQuerySchema, sendMessageSchema } from "@/lib/validations/chat"
import { generateUniqueAnonymousName } from "@/lib/anonymous-names"
import { moderateMessage, checkSpam } from "@/lib/moderation"
import { deliverToRoom, previewFor } from "@/lib/room-delivery"
import { checkAndAutoUnmute, hideMessage, flagForReview, checkAndAutoMute } from "@/lib/moderation/actions"
import { checkKeywords } from "@/lib/moderation/keyword-filter"
import { checkTextContent, notChecked, type ModerationCheck } from "@/lib/moderation/openai-moderation"

interface RouteParams {
  params: Promise<{ eventId: string }>
}

/**
 * The three claims somebody can have on an event's room, in one query each.
 *
 * `findFirst` on check-ins is event-level rather than per-day on purpose:
 * attending any day of a multi-day run gets you the room for the whole run.
 *
 * RSVP counts only as `going`. `maybe`, `waitlisted` and `not_going` are not a
 * commitment, and `waitlisted` in particular means the event is full — putting
 * somebody in the room for a thing they may never get into is worse than
 * telling them no.
 */
async function resolveEntitlement(
  eventId: string,
  userId: string
): Promise<RoomEntitlement> {
  const [checkIn, rsvp, favourite] = await Promise.all([
    db.event_check_ins.findFirst({
      where: { event_id: eventId, user_id: userId },
      select: { status: true },
    }),
    db.event_rsvps.findUnique({
      where: { event_id_user_id: { event_id: eventId, user_id: userId } },
      select: { status: true },
    }),
    db.event_favorites.findUnique({
      where: { event_id_user_id: { event_id: eventId, user_id: userId } },
      select: { id: true },
    }),
  ])

  return roomEntitlement({
    checkedIn: checkIn?.status === "checked_in",
    rsvpGoing: rsvp?.status === "going",
    interested: !!favourite,
  })
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { eventId } = await params

    // Get authenticated user
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    // Parse query parameters
    const searchParams = Object.fromEntries(request.nextUrl.searchParams)
    const parsed = chatQuerySchema.safeParse(searchParams)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }

    const { page, limit, before, after } = parsed.data

    // Get chat group for event (create on demand if user is checked in).
    // `end_time` comes along so the response can say whether -- and until when
    // -- this room accepts writes, rather than the app finding out by being
    // rejected after the user has typed.
    let chatGroup = await db.chat_groups.findUnique({
      where: { event_id: eventId },
      include: { event: { select: { start_time: true, end_time: true } } },
    })

    if (!chatGroup) {
      /*
       * The room is created lazily, and only by somebody entitled to be in it.
       * Creating it for a passer-by would leave an empty room attached to every
       * event anybody ever opened.
       */
      const entitlement = await resolveEntitlement(eventId, authUser.userId)
      if (!entitlement) {
        return notFoundResponse("Chat not available for this event")
      }

      const event = await db.events.findUnique({
        where: { id: eventId, deleted_at: null },
        select: { title: true },
      })

      chatGroup = await db.chat_groups.create({
        data: {
          event_id: eventId,
          name: `${event?.title || "Event"} Chat`,
          description: `Chat for ${event?.title || "Event"}`,
          status: "active",
          member_count: 0,
        },
        include: { event: { select: { start_time: true, end_time: true } } },
      })
    }

    // Check if user is a member of the chat group
    const membership = await db.chat_group_members.findUnique({
      where: {
        chat_group_id_user_id: {
          chat_group_id: chatGroup.id,
          user_id: authUser.userId,
        },
      },
    })

    /*
     * Auto-join, but never a resurrection.
     *
     * This read `membership.status !== "active"`, and its `update` set
     * `status: "active"` — so a **banned** member who was still checked in got
     * un-banned simply by opening the chat. A moderator's decision lasted until
     * the next pull-to-refresh, and it silently defeated the `banned` branch of
     * `mayWriteToRoom` below, because by the time that ran the row said active.
     *
     * `muted` is excluded for the same reason; it expires on its own timer
     * (`checkAndAutoUnmute`), not by revisiting the screen.
     *
     * `left` is the one status that SHOULD rejoin: it means the window closed
     * and the room was archived, and the row is kept only to hold the pseudonym.
     */
    const needsJoin =
      !membership || (membership.status !== "active" && membership.status !== "banned" && membership.status !== "muted")

    if (needsJoin) {
      /*
       * Two ways in now, and they are not equivalent.
       *
       * Checking in is a tap *at the venue with GPS agreeing*. An RSVP or a
       * saved event is a tap from anywhere, so it admits a much broader group —
       * which is exactly why it is only good inside `PRE_EVENT_CHAT_HOURS`.
       * Without that bound, tapping a heart on a festival three months out
       * would be a licence to a public channel for three months.
       */
      const entitlement = await resolveEntitlement(eventId, authUser.userId)
      const window = chatWindowState(chatGroup.event, chatGroup)

      if (!entitlementAdmits(entitlement, window)) {
        // Says which of the two things is missing, because they have different
        // remedies: turn up, or come back tomorrow.
        return forbiddenResponse(
          entitlement
            ? chatClosedMessage(window.open ? "window_closed" : window.reason)
            : "RSVP to this event to join the chat"
        )
      }

      const anonName = await generateUniqueAnonymousName(chatGroup.id)
      await db.chat_group_members.upsert({
        where: {
          chat_group_id_user_id: {
            chat_group_id: chatGroup.id,
            user_id: authUser.userId,
          },
        },
        create: {
          chat_group_id: chatGroup.id,
          user_id: authUser.userId,
          role: "member",
          status: "active",
          last_allowed_at: null,
          anonymous_name: anonName,
        },
        update: {
          status: "active",
          last_allowed_at: null,
          updated_at: new Date(),
        },
      })

      await db.chat_groups.update({
        where: { id: chatGroup.id },
        data: { member_count: { increment: 1 } },
      })
    }

    /*
     * The membership re-read that used to sit here is gone with the history
     * clamp that was its only consumer — one fewer round trip on the hottest
     * read in the room.
     */

    // Build anonymous name map from chat_group_members
    const allMembers = await db.chat_group_members.findMany({
      where: { chat_group_id: chatGroup.id },
      select: { user_id: true, anonymous_name: true },
    })
    const anonMap = new Map(
      allMembers.map((m) => [m.user_id, m.anonymous_name || "Attendee"])
    )

    // Build where clause for messages — include moderation-hidden messages
    // for the sender so they see "This message was removed" placeholders
    /*
     * A blocked person's messages do not appear in the room.
     *
     * `blocked_users` had never been consulted anywhere in group chat, so
     * blocking someone removed your ability to DM them and nothing else --
     * their messages still arrived in the history, over the socket and as a
     * push notification.
     */
    const blockedIds = await blockCounterparties(authUser.userId)

    const where: Record<string, unknown> = {
      chat_group_id: chatGroup.id,
      ...(blockedIds.length ? { user_id: { notIn: blockedIds } } : {}),
      OR: [
        { deleted_at: null },
        { moderation_status: "hidden", user_id: authUser.userId },
      ],
    }

    /*
     * History is NOT truncated at check-out.
     *
     * This used to clamp `created_at <= last_allowed_at`, so once you checked
     * out you could only read up to the moment you left. Combined with the write
     * gate it made the 24-hour window doubly dead: the room reopened after the
     * event, people talked, and everybody it was built for saw an empty room and
     * could not have answered anyway.
     *
     * Same rule as writing, and the same reason — see `mayWriteToRoom`.
     * Membership is an attendance record. You were in that room; the
     * conversation is the room's, not a souvenir of your visit.
     */

    if (before) {
      where.created_at = { ...(where.created_at || {}), lt: new Date(before) }
    }
    if (after) {
      where.created_at = { ...(where.created_at || {}), gt: new Date(after) }
    }

    // Get total count
    const totalCount = await db.chat_messages.count({ where })

    // Fetch messages with user info
    const messages = await db.chat_messages.findMany({
      where,
      include: {
        user: {
          select: {
            id: true,
            name: true,
            image: true,
          },
        },
        reactions: {
          include: {
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
      skip: (page - 1) * limit,
      take: limit,
    })

    // Update last read message for user
    if (messages.length > 0) {
      await db.chat_group_members.update({
        where: {
          chat_group_id_user_id: {
            chat_group_id: chatGroup.id,
            user_id: authUser.userId,
          },
        },
        data: {
          last_read_message_id: messages[0].id,
          updated_at: new Date(),
        },
      })
    }

    /*
     * Whether this room takes writes, and why not.
     *
     * The composer used to guess. Every refusal came back as one
     * `NOT_CHECKED_IN` covering several unrelated situations, so the app either
     * showed the wrong reason or let someone type a paragraph and then threw it
     * away. `closesAt` lets the room say "6 hours left" honestly instead of
     * counting down to a number it inferred.
     */
    const denial = mayWriteToRoom(
      // Null only when the auto-join above just created the row, which creates
      // it `active`. A banned or muted row is never replaced, so it arrives here
      // intact and `mayWriteToRoom` sees the truth.
      membership ?? { status: "active" },
      chatGroup.event,
      chatGroup
    )

    return successResponse({
      chatGroupId: chatGroup.id,
      chatGroupName: chatGroup.name,
      write: {
        allowed: denial === null,
        reason: denial?.reason ?? null,
        message: denial && denial.reason !== "muted" && denial.reason !== "banned"
          ? chatClosedMessage(denial.reason)
          : null,
        /** When the 24-hour window shuts. Independent of the archive job. */
        closesAt: chatClosesAt(chatGroup.event),
        /** Past this, the room is a read-only record of the night. */
        eventEndedAt: chatGroup.event.end_time,
      },
      messages: messages.reverse().map((m) => {
        const isHidden = m.moderation_status === "hidden"
        return {
          id: m.id,
          type: m.type,
          content: isHidden ? null : m.content,
          moderation_hidden: isHidden,
          metadata: isHidden ? null : m.metadata,
          isEdited: m.is_edited,
          isPinned: m.is_pinned,
          createdAt: m.created_at,
          editedAt: m.edited_at,
          parentId: m.parent_id,
          replyCount: m._count.replies,
          user: {
            id: m.user.id,
            name: anonMap.get(m.user.id) || "Attendee",
            image: null,
          },
          reactions: isHidden ? [] : m.reactions.map((r) => ({
            emoji: r.emoji,
            userId: r.user_id,
            userName: anonMap.get(r.user_id) || "Attendee",
          })),
          isOwn: m.user_id === authUser.userId,
        }
      }),
      pagination: {
        page,
        limit,
        totalCount,
        totalPages: Math.ceil(totalCount / limit),
        hasMore: page * limit < totalCount,
      },
    })
  } catch (error) {
    logger.error("Get chat messages error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to get messages")
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { eventId } = await params

    // Get authenticated user
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    const limited = await rateLimit(request, userLimit("write", "event-chat", authUser.userId))
    if (limited) return limited

    const body = await request.json()

    // Validate input
    const parsed = sendMessageSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }

    const { content, type, parentId, metadata } = parsed.data

    // Get chat group for event (create on demand if user is checked in)
    let chatGroup = await db.chat_groups.findUnique({
      where: { event_id: eventId },
      // `start_time` AND `end_time` decide the write window — see
      // lib/chat-window.ts. Selecting only `end_time` left `start_time`
      // undefined here, so the pre-event floor added in #262 silently did not
      // apply on this path while it did on the GET twin above: one room, two
      // endpoints, opposite answers about whether chat is open.
      include: { event: { select: { start_time: true, end_time: true } } },
    })

    if (!chatGroup) {
      /*
       * The same entitlement the GET twin uses to create the room lazily.
       *
       * This asked for a check-in, so an RSVP'd user who opened the chat (which
       * creates the room) and then sent the first message got 404 on the send
       * -- the room they were looking at "not available". Two endpoints
       * creating one room on two different conditions.
       */
      const entitlement = await resolveEntitlement(eventId, authUser.userId)
      if (!entitlement) {
        return notFoundResponse("Chat not available for this event")
      }

      const event = await db.events.findUnique({
        where: { id: eventId, deleted_at: null },
        select: { title: true, end_time: true },
      })
      if (!event) {
        return notFoundResponse("Chat not available for this event")
      }

      chatGroup = await db.chat_groups.create({
        data: {
          event_id: eventId,
          name: `${event.title || "Event"} Chat`,
          description: `Chat for ${event.title || "Event"}`,
          status: "active",
          member_count: 0,
        },
        include: { event: { select: { start_time: true, end_time: true } } },
      })
    }

    /*
     * Same rule as the other write path — see lib/chat-window.ts.
     *
     * Applied after the create-on-demand branch on purpose: a room created for
     * an event that finished last month must close immediately, not be born
     * open because it happens to be new.
     */
    const window = chatWindowState(chatGroup.event, chatGroup)
    if (!window.open) {
      return forbiddenResponse(chatClosedMessage(window.reason))
    }

    // Check if user is a member of the chat group
    const membership = await db.chat_group_members.findUnique({
      where: {
        chat_group_id_user_id: {
          chat_group_id: chatGroup.id,
          user_id: authUser.userId,
        },
      },
    })

    // Check muted/banned BEFORE auto-join logic — do not re-activate restricted users
    if (membership?.status === "muted") {
      // Check if the auto-mute window has expired (1 hour)
      const wasUnmuted = await checkAndAutoUnmute(authUser.userId, chatGroup.id)
      if (!wasUnmuted) {
        return errorResponse(
          "You are muted in this chat. Your messages have been flagged for policy violations.",
          403,
          ErrorCode.USER_MUTED
        )
      }
      // User was auto-unmuted, proceed with sending
    }
    if (membership?.status === "banned") {
      return errorResponse(
        "You have been banned from this chat due to repeated policy violations.",
        403,
        ErrorCode.USER_BANNED
      )
    }

    /*
     * Auto-join, through the same resolver the GET uses.
     *
     * This hand-rolled its own gate -- `checkIn?.status !== "checked_in"` --
     * while the GER above resolves an entitlement that also admits an RSVP or a
     * saved event inside the pre-event window. So the two handlers on one
     * resource disagreed about one person: the GET told an RSVP'd user
     * `write.allowed: true`, the composer opened, and the POST answered
     * NOT_CHECKED_IN after they had typed.
     *
     * Fixing only the write path would have left half the bug, because the lie
     * is on the read: the user was told they could write. One resolver, both
     * handlers, is the only version of this that stays fixed.
     */
    if (!membership) {
      const entitlement = await resolveEntitlement(eventId, authUser.userId)
      const window = chatWindowState(chatGroup.event, chatGroup)

      if (!entitlementAdmits(entitlement, window)) {
        // Which of the two things is missing, because the remedies differ:
        // turn up, or come back tomorrow.
        return errorResponse(
          entitlement
            ? chatClosedMessage(window.open ? "window_closed" : window.reason)
            : "RSVP to this event to join the chat",
          403,
          ErrorCode.NOT_CHECKED_IN
        )
      }

      const postAnonName = await generateUniqueAnonymousName(chatGroup.id)
      await db.chat_group_members.create({
        data: {
          chat_group_id: chatGroup.id,
          user_id: authUser.userId,
          role: "member",
          status: "active",
          last_allowed_at: null,
          anonymous_name: postAnonName,
        },
      })

      await db.chat_groups.update({
        where: { id: chatGroup.id },
        data: { member_count: { increment: 1 } },
      })
    }

    const membershipFresh = membership
      ? membership
      : await db.chat_group_members.findUnique({
          where: {
            chat_group_id_user_id: {
              chat_group_id: chatGroup.id,
              user_id: authUser.userId,
            },
          },
        })

    /*
     * The same rule as the other write path — see `mayWriteToRoom`.
     *
     * What was here denied on `last_allowed_at` being set *at all*, not merely
     * being in the past, so one check-out silenced a member permanently even
     * inside the 24-hour feedback window the room exists for.
     *
     * Joining still requires presence (the auto-join above refuses anyone not
     * currently `checked_in` — you have to be there to get in). Continuing to
     * write does not: leaving does not unsee what you saw.
     */
    if (membershipFresh) {
      const denial = mayWriteToRoom(membershipFresh, chatGroup.event, chatGroup)
      if (denial) {
        if (denial.reason === "banned") {
          return errorResponse(
            "You have been banned from this chat.",
            403,
            ErrorCode.USER_BANNED
          )
        }
        if (denial.reason === "muted") {
          return errorResponse(
            "You are muted in this chat.",
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
    }

    // If replying, verify parent message exists
    if (parentId) {
      const parentMessage = await db.chat_messages.findUnique({
        where: { id: parentId, chat_group_id: chatGroup.id },
      })
      if (!parentMessage) {
        return notFoundResponse("Parent message not found")
      }
    }

    // Spam check (sync — block before saving)
    const spamResult = await checkSpam(authUser.userId, chatGroup.id, content)
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
      // Save but immediately mark as hidden — never emitted to other users
      const message = await db.chat_messages.create({
        data: {
          chat_group_id: chatGroup.id,
          user_id: authUser.userId,
          content,
          type,
          parent_id: parentId,
          metadata: metadata as Prisma.InputJsonValue | undefined,
          moderation_status: "hidden",
          deleted_at: new Date(),
        },
      })
      void flagForReview(message.id, chatGroup.id, authUser.userId, keywordResult)
      void checkAndAutoMute(authUser.userId, chatGroup.id)
      return successResponse({
        message: {
          id: message.id,
          type: message.type,
          content: null,
          moderation_hidden: true,
          createdAt: message.created_at,
        },
      })
    }

    // Create message
    const message = await db.chat_messages.create({
      data: {
        chat_group_id: chatGroup.id,
        user_id: authUser.userId,
        content,
        type,
        parent_id: parentId,
        metadata: metadata as Prisma.InputJsonValue | undefined,
      },
    })

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
          await hideMessage(message.id, chatGroup.id, authUser.userId, openaiResult)
          await flagForReview(message.id, chatGroup.id, authUser.userId, openaiResult)
          void checkAndAutoMute(authUser.userId, chatGroup.id)
          return successResponse({
            message: {
              id: message.id,
              type: message.type,
              content: null,
              moderation_hidden: true,
              createdAt: message.created_at,
            },
          })
        }
        if (openaiResult && openaiResult.action === "flag") {
          void flagForReview(message.id, chatGroup.id, authUser.userId, openaiResult)
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
          void moderateMessage(message.id, content, type, authUser.userId, chatGroup.id)
        }
      } catch {
        void moderateMessage(message.id, content, type, authUser.userId, chatGroup.id)
      }
    } else {
      void moderateMessage(
        message.id,
        content,
        type,
        authUser.userId,
        chatGroup.id,
        (metadata as Record<string, string> | undefined)?.mediaUrl
      )
    }

    // Mark clean if passed all checks
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
            context: "event chat message",
            error: err instanceof Error ? err.message : String(err),
          })
        )
    }

    // Get anonymous name for response
    const senderMembership = await db.chat_group_members.findUnique({
      where: {
        chat_group_id_user_id: {
          chat_group_id: chatGroup.id,
          user_id: authUser.userId,
        },
      },
      select: { anonymous_name: true },
    })

    // Update chat group last_message_at
    await db.chat_groups.update({
      where: { id: chatGroup.id },
      data: {
        last_message_at: new Date(),
        updated_at: new Date(),
      },
    })

    /*
     * Deliver it. This handler persisted the message and stopped.
     *
     * No socket emit and no push, so a message sent from the event chat screen
     * was **invisible to everyone else until they re-polled** -- and for anyone
     * who already had the room open, that is never. The sibling endpoint,
     * writing to the same `chat_messages` table for the same group, has always
     * done both.
     *
     * After moderation, never before. Emitting first and moderating after
     * creates a window where flagged content is briefly visible to the room,
     * which was a real bug here once already.
     */
    await deliverToRoom({
      chatGroupId: chatGroup.id,
      groupName: chatGroup.name,
      senderId: authUser.userId,
      senderAnonName: senderMembership?.anonymous_name || "Attendee",
      message,
      preview: previewFor(type, content),
    })

    return successResponse(
      {
        message: {
          id: message.id,
          type: message.type,
          content: message.content,
          metadata: message.metadata,
          createdAt: message.created_at,
          parentId: message.parent_id,
          user: {
            id: authUser.userId,
            name: senderMembership?.anonymous_name || "Attendee",
            image: null,
          },
          reactions: [],
          isOwn: true,
        },
      },
      201
    )
  } catch (error) {
    logger.error("Send message error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to send message")
  }
}
