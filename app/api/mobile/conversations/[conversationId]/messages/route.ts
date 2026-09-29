import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { blockedEitherWay } from "@/lib/conversations"
import { db } from "@/lib/db"
import { media_type, type Prisma } from "@prisma/client"
import { openThread, quoteOf, replyToSelect } from "@/lib/dm-thread"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { participationRefusal } from "@/lib/event-access"
import { rateLimit, createUserRateLimit } from "@/lib/rate-limit"
import {
  successResponse,
  errorResponse,
  ErrorCode,
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
import { isOwnChatMedia, NOT_OWN_MEDIA, sealChatMedia } from "@/lib/validations/chat"
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

const sendMessageSchema = z.object({
  text: z.string().min(1).max(5000).optional(),
  mediaUrl: z.string().url().optional(),
  mediaType: z.enum(["image", "video"]).optional(),
  /** The message this one replies to; must be in the same conversation. */
  replyToId: z.string().uuid().optional(),
  /** The app's own id for this send: a retry with it returns the first write. */
  clientId: z.string().uuid().optional(),
}).refine(
  (data) => data.text || data.mediaUrl,
  { message: "Message must have text or media" }
)

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

    // Verify conversation exists and user has access
    const conversation = await db.private_conversations.findUnique({
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
    })

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

    // Build query
    /*
     * `VISIBLE_DM` excludes a message the deterministic checks hid. It is
     * excluded for the sender too, which is the same answer the group route
     * gives: a hidden message is stored as evidence for a later report, not
     * kept readable by the person who sent it.
     */
    const whereClause: Record<string, unknown> = {
      conversation_id: conversationId,
      ...VISIBLE_DM,
    }
    if (before) {
      whereClause.created_at = { lt: new Date(before) }
    }

    const messages = await db.private_messages.findMany({
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
    })

    // Mark unread messages as read
    /*
     * The first page opens the thread: where the unread start, answered before
     * anything is marked, then the whole thread read and delivered
     * (`openThread`). Older pages mark nothing — the first page already did.
     */
    const opened = before ? null : await openThread(conversationId, authUser.userId)

    const otherParty = conversation.user1_id === authUser.userId ? conversation.user2 : conversation.user1

    // Format for mobile app
    const formattedMessages = messages.map((msg) => ({
      id: msg.id,
      conversationId: msg.conversation_id,
      senderId: msg.sender_id,
      // The pseudonym holds on every message, not just the header.
      sender: {
        ...msg.sender,
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
    }))

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

    // Not onboarded and no adult age on file: may not take part yet (SCRUM-331).
    const unfinished = await participationRefusal(authUser.userId)
    if (unfinished) return forbiddenResponse(unfinished)

    const body = await readJson(request)
    const parsed = sendMessageSchema.safeParse(body)

    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }

    const { text, mediaUrl, mediaType, replyToId, clientId } = parsed.data

    // The sender's own upload, or no media (SCRUM-426).
    if (mediaUrl && !isOwnChatMedia(mediaUrl, authUser.userId)) {
      return errorResponse(NOT_OWN_MEDIA, 400)
    }

    // Verify conversation exists and user has access
    const conversation = await db.private_conversations.findUnique({
      where: { id: conversationId },
      include: {
        user1: { select: { id: true, name: true, image: true } },
        user2: { select: { id: true, name: true, image: true } },
      },
    })

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

    // Group chat sends and check-ins are rate limited; DM sends were not, so a
    // single account could flood a conversation and its push notifications.
    /** One shape for a new message and for a retry that finds its first write. */
    const sentData = (m: SentMessage) => ({
      id: m.id,
      conversationId: m.conversation_id,
      senderId: m.sender_id,
      sender: {
        ...m.sender,
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

    /*
     * A retry of a send that already landed (SCRUM-410): the request reached
     * us, the response did not reach the phone, and "Tap to retry" sent it
     * again. Answered with the first write — before the rate limit, which a
     * retry should not spend, and before the checks, which it already passed.
     */
    if (clientId) {
      const existing = await db.private_messages.findUnique({
        where: { sender_id_client_id: { sender_id: authUser.userId, client_id: clientId } },
        include: sentInclude,
      })
      if (existing) {
        if (existing.conversation_id !== conversationId) {
          return errorResponse("That message id belongs to another conversation", 409)
        }
        return answer(existing)
      }
    }

    if (replyToId) {
      const quoted = await db.private_messages.findFirst({
        where: { id: replyToId, conversation_id: conversationId },
        select: { id: true },
      })
      if (!quoted) return errorResponse("You can only reply to a message in this conversation", 400)
    }

    const limited = await rateLimit(request, createUserRateLimit("private-message", authUser.userId))
    if (limited) return limited

    // Check if the recipient has blocked the sender
    const recipientId =
      conversation.user1_id === authUser.userId
        ? conversation.user2_id
        : conversation.user1_id

    /*
     * Both directions. This only asked whether the recipient had blocked the
     * sender, so someone who had blocked the other person could still message
     * them — which is not what "block" means to either party, and leaves the
     * blocker receiving replies from a person they have chosen not to hear from.
     */
    if (await blockedEitherWay(authUser.userId, recipientId)) {
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
      return errorResponse(screen.reason, 429, ErrorCode.SPAM_BLOCKED)
    }
    const hidden = screen.verdict === "hide"

    /*
     * What is stored is the upload's sealed copy, which nobody can write to
     * (SCRUM-425). Made here, after every gate, so a refused send copies nothing.
     */
    const media = mediaUrl ? await sealChatMedia(mediaUrl, authUser.userId) : null
    if (media && "refusal" in media) return errorResponse(media.refusal, 400)

    // Create the message
    let message: SentMessage
    try {
      message = await db.private_messages.create({
      data: {
        conversation_id: conversationId,
        sender_id: authUser.userId,
        // Optional behind the "text or media" refinement, so a media-only DM
        // arrived as an explicit undefined — the same outage as the media
        // columns below, from the other side of the same refinement.
        message_text: text ?? null,
        // Both optional in the schema, so undefined whenever a text-only DM is
        // sent — which is every DM. Explicit undefined threw under
        // `strictUndefinedChecks`, so sending a DM returned 500. Found by
        // sending one from the simulator after a match.
        ...(media != null && { media_url: media.url }),
        ...(mediaType != null && { media_type: mediaType as media_type }),
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
    if (!hidden) {
      await db.private_conversations.update({
        where: { id: conversationId },
        data: { last_message_at: new Date(), updated_at: new Date() },
      })
    }

    // Emit via Socket.io
    const messageData = sentData(message)

    /*
     * Neither delivered nor announced.
     *
     * The row exists so a later report has something to rest on —
     * `moderation_flags.message_id` is a NOT NULL foreign key to
     * `chat_messages`, so a flag against a DM is structurally impossible and
     * the message itself is the only record. It is stored, and it is not sent.
     */
    if (!hidden) {
      emitPrivateMessage(conversationId, recipientId, messageData)
    }

    /*
     * The push TITLE, resolved through the conversation.
     *
     * This was `message.sender.name`, so a lock screen would carry the real
     * name of someone the recipient only knows by a pseudonym -- and a lock
     * screen is not an authenticated surface. Unchanged for conversations that
     * were never pseudonymous, which is all of them until the reveal work
     * lands.
     */
    const senderName = displayNameInConversation(
      conversation,
      authUser.userId,
      message.sender.name
    )
    const messagePreview = text || (mediaType === "image" ? "📷 Photo" : "🎥 Video")
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
          notifyPrivateMessage({ recipientId, senderName, preview: messagePreview, conversationId, unread })
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
