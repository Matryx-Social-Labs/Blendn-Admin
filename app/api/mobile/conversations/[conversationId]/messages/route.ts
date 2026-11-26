import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { blockedEitherWay } from "@/lib/conversations"
import { db } from "@/lib/db"
import type { Prisma } from "@prisma/client"
import { openThread, quoteOf, replyToSelect } from "@/lib/dm-thread"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { participationRefusal } from "@/lib/event-access"
import { rateLimit, createUserRateLimit } from "@/lib/rate-limit"
import {
  successResponse,
  errorResponse,
  spamBlockedResponse,
  validationErrorResponse,
  unauthorizedResponse,
  forbiddenResponse,
  notFoundResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { z } from "zod"
import { displayNameInConversation, mayShowRealName } from "@/lib/conversation-identity"
import { screenDirectMessage, VISIBLE_DM } from "@/lib/dm-moderation"
import { emitPrivateMessage } from "@/lib/socket-server"
import { isReadForViewer } from "@/lib/read-receipts"
import { notifyPrivateMessage } from "@/lib/push-notifications"
import { DM_PHOTOS_OFF } from "@/lib/validations/chat"
import { idInConversation } from "@/lib/conversation-ref"
import { readJson, isUuid } from "@/lib/api-input"
import { boundedInt } from "@/lib/pagination"

const sentInclude = {
  sender: { select: { id: true, name: true, image: true } },
  reply_to: replyToSelect,
} as const
type SentMessage = Prisma.private_messagesGetPayload<{ include: typeof sentInclude }>

interface RouteParams {
  params: Promise<{ conversationId: string }>
}

/** Words only: a send with media is refused before this (SCRUM-1165). */
const sendMessageSchema = z.object({
  text: z.string().min(1).max(5000),
  /** The message this one replies to; must be in the same conversation. */
  replyToId: z.string().uuid().optional(),
  /** The app's own id for this send: a retry with it returns the first write. */
  clientId: z.string().uuid().optional(),
})

// GET /api/mobile/conversations/[conversationId]/messages - Get messages
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { conversationId } = await params
    if (!isUuid(conversationId)) return errorResponse("Invalid conversation ID format", 400)
    const { searchParams } = new URL(request.url)
    const limit = boundedInt(searchParams.get("limit"), 50, 1, 100)
    const before = searchParams.get("before") // cursor for pagination: a timestamp
    // A time after 1970: `Date.parse` takes year 0, which Postgres refuses.
    if (before && !(Date.parse(before) >= 0)) return errorResponse("Invalid cursor", 400)

    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    /*
     * Build query
     * `VISIBLE_DM` excludes a message the deterministic checks hid, and the
     * recipient never sees one. The sender does, as a removed message (RC8):
     * they were told at send time (`moderation_hidden: true`), and a reload
     * that dropped the bubble made it look as if it had never been sent. The
     * other `VISIBLE_DM` readers -- inbox preview, unread counts, pushes,
     * badge, mark-as-read -- are unchanged; a hidden row is never delivered.
     */
    const whereClause: Record<string, unknown> = {
      conversation_id: conversationId,
      OR: [...VISIBLE_DM.OR, { moderation_status: "hidden", sender_id: authUser.userId }],
    }
    if (before) {
      whereClause.created_at = { lt: new Date(before) }
    }

    /*
     * The conversation and its messages are independent reads, so one level, not
     * two. Access is decided below, before anything read here is returned or
     * the thread is opened (`openThread` writes): a stranger gets the refusal
     * and none of it.
     */
    const [conversation, messages] = await Promise.all([
      // Verify conversation exists and user has access
      db.private_conversations.findUnique({
        where: { id: conversationId },
        include: {
          // The other party's `read_receipts` decides whether the caller may be
          // told their message was read. The list route already asks; this one
          // projected `is_read` raw, so a reader who turned receipts off was
          // reported read on every reload. Driven 2026-09-13 with a probe: the
          // socket stayed silent and the GET said `isRead: true`.
          user1: { select: { profile: { select: { read_receipts: true } } } },
          user2: { select: { profile: { select: { read_receipts: true } } } },
        },
        }),
      db.private_messages.findMany({
        where: whereClause,
        orderBy: { created_at: "desc" },
        take: limit,
        include: {
          sender: {
            select: {
              id: true,
              name: true,
              image: true,
            },
          },
          reply_to: replyToSelect,
        },
      }),
    ])

    if (!conversation) {
      return notFoundResponse("Conversation not found")
    }

    if (
      conversation.user1_id !== authUser.userId &&
      conversation.user2_id !== authUser.userId
    ) {
      return forbiddenResponse("Not authorized to view this conversation")
    }

    // Closed conversations are gone for both people. Retained for moderation,
    // not readable by the participants -- see lib/conversations.ts.
    if (conversation.closed_at) {
      return notFoundResponse("Conversation not found")
    }

    // Mark unread messages as read
    /*
     * The first page opens the thread: where the unread start, answered before
     * anything is marked, then the whole thread read and delivered
     * (`openThread`). Older pages mark nothing — the first page already did.
     */
    const opened = before ? null : await openThread(conversationId, authUser.userId)

    const otherParty = conversation.user1_id === authUser.userId ? conversation.user2 : conversation.user1

    // Format for mobile app
    const formattedMessages = messages.map((msg) => {
      const shown = {
        id: msg.id,
        conversationId: msg.conversation_id,
        senderId: idInConversation(conversation, authUser.userId, msg.sender_id),
        // The pseudonym holds on every message, not just the header.
        sender: {
          ...msg.sender,
          id: idInConversation(conversation, authUser.userId, msg.sender.id),
          name: displayNameInConversation(conversation, msg.sender.id, msg.sender.name),
          image: mayShowRealName(conversation, msg.sender.id) ? msg.sender.image : null,
        },
        text: msg.message_text,
        mediaUrl: msg.media_url,
        mediaType: msg.media_type,
        isRead: isReadForViewer({
          senderIsViewer: msg.sender_id === authUser.userId,
          isRead: msg.is_read,
          otherPartyAllowsReceipts: otherParty.profile?.read_receipts,
        }),
        // Your own messages only: ✓✓ once their app has it (SCRUM-408).
        deliveredAt: msg.sender_id === authUser.userId ? msg.delivered_at : undefined,
        replyTo: quoteOf(conversation, msg.reply_to),
        createdAt: msg.created_at,
      }
      // Only the sender's own hidden rows reach here (the query): shown as
      // removed, content withheld. `mediaType` stays, so a withheld photo
      // draws the photo-sized frame.
      return msg.moderation_status === "hidden"
        ? { ...shown, moderation_hidden: true, text: null, mediaUrl: null, replyTo: null, isRead: false, deliveredAt: null }
        : shown
    })

    return successResponse({
      messages: formattedMessages,
      ...(opened && { firstUnreadId: opened.firstUnreadId, unreadCount: opened.unreadCount }),
      hasMore: messages.length === limit,
      nextCursor: messages.length > 0 ? messages[messages.length - 1].created_at.toISOString() : null,
    })
  } catch (error) {
    logger.error("Get messages error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to get messages")
  }
}

// POST /api/mobile/conversations/[conversationId]/messages - Send message
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { conversationId } = await params
    if (!isUuid(conversationId)) return errorResponse("Invalid conversation ID format", 400)

    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    /*
     * The reads that do not wait on each other start together: whether this
     * person may take part, the conversation, and (below, once the body says
     * which send it is) whether this is a retry. They were three round trips in
     * a row. Every refusal is still decided in the old order, from what they
     * return, and each is marked handled here because a refusal returns without
     * reading the ones after it.
     */
    // Not onboarded and no adult age on file: may not take part yet (SCRUM-331).
    const unfinishedPending = participationRefusal(authUser.userId)
    const conversationPending = db.private_conversations.findUnique({
      where: { id: conversationId },
      include: {
        user1: { select: { id: true, name: true, image: true } },
        user2: { select: { id: true, name: true, image: true } },
      },
    })
    unfinishedPending.catch(() => undefined)
    conversationPending.catch(() => undefined)

    const body = await readJson(request)
    const parsed = sendMessageSchema.safeParse(body)
    const retryPending =
      parsed.success && parsed.data.clientId
        ? db.private_messages.findUnique({
            where: { sender_id_client_id: { sender_id: authUser.userId, client_id: parsed.data.clientId } },
            include: sentInclude,
          })
        : null
    retryPending?.catch(() => undefined)

    const unfinished = await unfinishedPending
    if (unfinished) return forbiddenResponse(unfinished)

    // A DM is words only (SCRUM-1165): a send carrying any media is refused whole, with a sentence the app shows as it is.
    if ((body as { mediaUrl?: unknown } | null)?.mediaUrl != null) return forbiddenResponse(DM_PHOTOS_OFF)

    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }

    const { text, replyToId, clientId } = parsed.data

    /*
     * A retry of a send that already landed (SCRUM-410): the request reached
     * us, the response did not reach the phone, and "Tap to retry" sent it
     * again. Answered with the first write, below, and a retry does not spend
     * the rate limit. Every other send does, before the lookups that refuse
     * it: a random id, somebody else's conversation or a quote from elsewhere
     * went uncounted when the limit came after them (SCRUM-451).
     */
    const retried = retryPending ? await retryPending : null
    if (retried?.conversation_id !== conversationId) {
      const limited = await rateLimit(request, createUserRateLimit("private-message", authUser.userId))
      if (limited) return limited
    }

    // Verify conversation exists and user has access
    const conversation = await conversationPending

    if (!conversation) {
      return notFoundResponse("Conversation not found")
    }

    if (
      conversation.user1_id !== authUser.userId &&
      conversation.user2_id !== authUser.userId
    ) {
      return forbiddenResponse("Not authorized to send messages to this conversation")
    }

    // Closed conversations are gone for both people. Retained for moderation,
    // not readable by the participants -- see lib/conversations.ts.
    if (conversation.closed_at) {
      return notFoundResponse("Conversation not found")
    }

    /** One shape for a new message and for a retry that finds its first write. */
    const sentData = (m: SentMessage, viewerId: string = authUser.userId) => ({
      id: m.id,
      conversationId: m.conversation_id,
      senderId: idInConversation(conversation, viewerId, m.sender_id),
      sender: {
        ...m.sender,
        id: idInConversation(conversation, viewerId, m.sender.id),
        name: displayNameInConversation(conversation, m.sender.id, m.sender.name),
        image: mayShowRealName(conversation, m.sender.id) ? m.sender.image : null,
      },
      text: m.message_text,
      mediaUrl: m.media_url,
      mediaType: m.media_type,
      isRead: m.is_read,
      deliveredAt: m.delivered_at,
      replyTo: quoteOf(conversation, m.reply_to),
      clientId: m.client_id,
      createdAt: m.created_at,
    })
    const answer = (m: SentMessage) =>
      m.moderation_status === "hidden"
        ? successResponse({ ...sentData(m), text: null, moderation_hidden: true })
        : successResponse(sentData(m))

    // The retry, answered before the checks it already passed.
    if (retried) {
      if (retried.conversation_id !== conversationId) {
        return errorResponse("That message id belongs to another conversation", 409)
      }
      return answer(retried)
    }

    // Check if the recipient has blocked the sender
    const recipientId =
      conversation.user1_id === authUser.userId
        ? conversation.user2_id
        : conversation.user1_id

    // The quoted message and the block are independent reads; a missing quote still answers first.
    const [quoted, blocked] = await Promise.all([
      replyToId
        ? db.private_messages.findFirst({
            where: { id: replyToId, conversation_id: conversationId },
            select: { id: true },
          })
        : null,
      blockedEitherWay(authUser.userId, recipientId),
    ])
    if (replyToId && !quoted) return errorResponse("You can only reply to a message in this conversation", 400)

    /*
     * Both directions. This only asked whether the recipient had blocked the
     * sender, so someone who had blocked the other person could still message
     * them — which is not what "block" means to either party, and leaves the
     * blocker receiving replies from a person they have chosen not to hear from.
     */
    if (blocked) {
      // Deliberately does not say which direction the block runs in.
      return forbiddenResponse("You cannot send messages to this user")
    }

    /*
     * The deterministic checks, which this path had none of.
     *
     * `lib/moderation` was imported by exactly two files and both were group
     * chat, so a DM got no keyword check, no spam check and no contact-info
     * check — in the one channel where somebody is alone with a stranger, and
     * the one `contact-info.ts` names as where the harm it targets lands.
     *
     * No model, deliberately (TR5): a model check sends an unreviewed private
     * message to a third party and, on a hit, turns it into something a human
     * may read. Nothing here is read by anybody unless it is reported.
     */
    const screen = await screenDirectMessage({
      senderId: authUser.userId,
      conversationId,
      text,
    })
    if (screen.verdict === "refuse") {
      return spamBlockedResponse(screen.reason, screen.retryAfter, screen.reasonCode)
    }
    const hidden = screen.verdict === "hide"

    // Create the message
    let message: SentMessage
    try {
      message = await db.private_messages.create({
      data: {
        conversation_id: conversationId,
        sender_id: authUser.userId,
        message_text: text,
        moderation_status: screen.status,
        ...(replyToId && { reply_to_id: replyToId }),
        ...(clientId && { client_id: clientId }),
      },
      include: sentInclude,
    })
    } catch (error) {
      // Two sends with one clientId raced, and the other wrote it first. The
      // driver adapter nests the constraint, so the code is all we can read.
      const raced =
        clientId && (error as { code?: string }).code === "P2002"
          ? await db.private_messages.findUnique({
              where: { sender_id_client_id: { sender_id: authUser.userId, client_id: clientId } },
              include: sentInclude,
            })
          : null
      if (!raced) throw error
      return answer(raced)
    }

    /*
     * A hidden message does not touch the conversation's clock.
     *
     * `last_message_at` drives the inbox ordering and the "new message" dot, so
     * bumping it would surface a thread the recipient has nothing to read in —
     * telling them somebody wrote, which is most of what the sender wanted.
     */
    const touched = hidden
      ? null
      : db.private_conversations.update({
          where: { id: conversationId },
          data: { last_message_at: new Date(), updated_at: new Date() },
        })
    touched?.catch(() => undefined) // awaited below; marked handled in case the emit throws first

    // Emit via Socket.io — before the clock write lands: the recipient's copy does not wait on it.
    const messageData = sentData(message)
    // The recipient's copy names the sender as the recipient may know them: a
    // handle until they reveal. The sender's own is their real id, as everywhere.
    const recipientData = sentData(message, recipientId)

    /*
     * Neither delivered nor announced.
     *
     * The row exists so a later report has something to rest on —
     * `moderation_flags.message_id` is a NOT NULL foreign key to
     * `chat_messages`, so a flag against a DM is structurally impossible and
     * the message itself is the only record. It is stored, and it is not sent.
     */
    if (!hidden) {
      emitPrivateMessage(conversationId, recipientId, recipientData, messageData)
    }
    await touched

    /*
     * The push TITLE, resolved through the conversation.
     *
     * This was `message.sender.name`, so a lock screen would carry the real
     * name of someone the recipient only knows by a pseudonym -- and a lock
     * screen is not an authenticated surface. A conversation that began as a
     * request has real names for good, so its push carries neither the name
     * nor the words (`notifyPrivateMessage` reads the conversation, SCRUM-1266);
     * a friends' DM keeps both.
     */
    const senderName = displayNameInConversation(
      conversation,
      authUser.userId,
      message.sender.name
    )
    if (!hidden) {
      /*
       * What the recipient has not read from this sender, this message
       * included: one means the conversation just went unread and rings, more
       * is a burst and is throttled (`notifyPrivateMessage`). Counted through
       * `VISIBLE_DM`, because a hidden message is never marked read.
       */
      db.private_messages
        .count({
          where: { conversation_id: conversationId, sender_id: authUser.userId, is_read: false, ...VISIBLE_DM },
        })
        .then((unread) =>
          notifyPrivateMessage({
            recipientId,
            senderName,
            preview: text,
            conversationId,
            unread,
            conversation,
          })
        )
        .catch((err) =>
          logger.error("Push notification failed", { error: err instanceof Error ? err.message : String(err) })
        )
    }

    /*
     * The sender is told, rather than left to conclude they were ignored.
     *
     * Same shape as the group route's `moderation_hidden`, and the same
     * argument: a silent drop teaches nothing and reads as the recipient not
     * replying, which is worse for the person who was not at fault.
     */
    if (hidden) {
      return successResponse({ ...messageData, text: null, moderation_hidden: true })
    }

    return successResponse(messageData)
  } catch (error) {
    logger.error("Send message error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to send message")
  }
}
