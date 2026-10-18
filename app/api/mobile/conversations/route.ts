import { markInboxDelivered } from "@/lib/dm-thread"
import { logger } from "@/lib/logger"
import { isReadForViewer } from "@/lib/read-receipts"
import { NextRequest } from "next/server"
import { ConversationClosedError, blockedEitherWay, mayConverse, openConversation } from "@/lib/conversations"
import { cameFromMatch, displayNameInConversation, mayShowRealName, isPseudonymous } from "@/lib/conversation-identity"
import { VISIBLE_DM } from "@/lib/dm-moderation"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { userIdFromRefIfIdentified } from "@/lib/identity"
import { participationRefusal } from "@/lib/event-access"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import {
  successResponse,
  errorResponse,
  validationErrorResponse,
  unauthorizedResponse,
  notFoundResponse,
  serverErrorResponse,
  conflictResponse,
  forbiddenResponse,
} from "@/lib/api-response"
import { z } from "zod"
import { readJson } from "@/lib/api-input"

const createConversationSchema = z.object({
  otherUserId: z.string().min(1, "Other user ID is required"),
})

/**
 * The preview on each inbox row: the newest message the thread would show.
 *
 * Raw, because Prisma 7 does not send a nested `take` to SQL: the relation read
 * was `WHERE conversation_id IN (...) ORDER BY created_at DESC` with no LIMIT,
 * so every DM of every conversation came back to keep one per thread. This is
 * one index probe per conversation on (conversation_id, created_at), newest
 * first, one row each. `VISIBLE_DM` in SQL: a hidden message would put words on
 * the inbox row that the thread refuses to show.
 */
async function lastVisibleMessages(conversationIds: string[]) {
  if (conversationIds.length === 0) return new Map<string, LastMessage>()
  const rows = await db.$queryRaw<(LastMessage & { conversation_id: string })[]>`
    SELECT m.conversation_id, m.id, m.message_text, m.sender_id, m.created_at, m.is_read
    FROM unnest(${conversationIds}::uuid[]) AS c(id)
    CROSS JOIN LATERAL (
      SELECT conversation_id, id, message_text, sender_id, created_at, is_read
      FROM private_messages
      WHERE conversation_id = c.id AND (moderation_status IS NULL OR moderation_status <> 'hidden')
      ORDER BY created_at DESC
      LIMIT 1
    ) m
  `
  return new Map(rows.map((r) => [r.conversation_id, r]))
}

/**
 * Unread, per conversation: not yours, not read, and visible.
 *
 * Was a relation `_count`, which Prisma emits as a LEFT JOIN onto
 * `SELECT conversation_id, COUNT(*) … GROUP BY conversation_id` over ALL of
 * private_messages (a Parallel Seq Scan of every unread DM on the platform per
 * inbox open, 210k rows locally); this names the person's own conversations.
 */
async function unreadCounts(conversationIds: string[], viewerId: string) {
  if (conversationIds.length === 0) return new Map<string, number>()
  const rows = await db.private_messages.groupBy({
    by: ["conversation_id"],
    where: {
      conversation_id: { in: conversationIds },
      is_read: false,
      sender_id: { not: viewerId },
      /*
       * The reader that gets forgotten. A hidden message is never
       * delivered, so it is never marked read — leaving it in this
       * count is a badge that cannot be cleared, on a thread with
       * nothing in it to clear.
       */
      ...VISIBLE_DM,
    },
    _count: true,
  })
  return new Map(rows.map((r) => [r.conversation_id, r._count]))
}

type LastMessage = {
  id: string
  message_text: string | null
  sender_id: string
  created_at: Date
  is_read: boolean
}

// GET /api/mobile/conversations - List user's conversations
export async function GET(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    const conversations = await db.private_conversations.findMany({
      where: {
        // Live only. A closed conversation is gone for BOTH people -- a
        // one-sided hide would leave the other person messaging into a thread
        // you have left, which is a harassment vector rather than a courtesy.
        closed_at: null,
        OR: [
          { user1_id: authUser.userId },
          { user2_id: authUser.userId },
        ],
      },
      include: {
        /*
         * `profile.read_receipts` rides along because the list reports
         * `lastMessage.isRead`, and when the last message is the caller's own
         * that field IS a read receipt. Fetching it per row afterwards would be
         * an N+1 on the conversations screen.
         */
        user1: {
          select: {
            id: true,
            name: true,
            image: true,
            profile: { select: { read_receipts: true } },
          },
        },
        user2: {
          select: {
            id: true,
            name: true,
            image: true,
            profile: { select: { read_receipts: true } },
          },
        },
      },
      orderBy: {
        last_message_at: "desc",
      },
    })

    const ids = conversations.map((c) => c.id)
    const [lastMessages, unread] = await Promise.all([lastVisibleMessages(ids), unreadCounts(ids, authUser.userId)])

    // Format conversations for the mobile app
    const formattedConversations = conversations.map((conv) => {
      const otherUser = conv.user1_id === authUser.userId ? conv.user2 : conv.user1
      const lastMessage = lastMessages.get(conv.id) ?? null

      /*
       * The other person's name and photo, gated on their reveal state.
       *
       * The inbox is the one surface where the pseudonym has to hold on its
       * own: it renders before any conversation is opened, so shipping the
       * gate only inside the thread would list every match by their real name.
       * `image` follows the same rule as `name` -- a face identifies as surely.
       */
      const otherRevealed = mayShowRealName(conv, otherUser.id)

      return {
        id: conv.id,
        otherUser: {
          id: otherUser.id,
          name: displayNameInConversation(conv, otherUser.id, otherUser.name),
          image: otherRevealed ? otherUser.image : null,
        },
        /**
         * Opened from a mutual like, rather than from an accepted message
         * request. The app draws the match opener on these and only these.
         */
        fromMatch: cameFromMatch(conv),
        /** False for an accepted message request: real names throughout, nothing to reveal. */
        pseudonymous: isPseudonymous(conv),
        /** Your own state, for the header. Never a count of who else revealed. */
        youRevealed: conv.user1_id === authUser.userId
          ? conv.user1_revealed
          : conv.user2_revealed,
        theyRevealed: otherRevealed,
        /** Whether they have asked you to reveal. There is no "declined". */
        revealRequested: conv.user1_id === authUser.userId
          ? conv.user1_reveal_requested
          : conv.user2_reveal_requested,
        lastMessage: lastMessage
          ? {
              id: lastMessage.id,
              text: lastMessage.message_text,
              senderId: lastMessage.sender_id,
              createdAt: lastMessage.created_at,
              /*
               * Withheld when the caller sent it and the other party has read
               * receipts off. Honouring the setting on the socket alone would
               * leak the same fact one screen away.
               */
              isRead: isReadForViewer({
                senderIsViewer: lastMessage.sender_id === authUser.userId,
                isRead: lastMessage.is_read,
                otherPartyAllowsReceipts: otherUser.profile?.read_receipts,
              }),
            }
          : null,
        unreadCount: unread.get(conv.id) ?? 0,
        updatedAt: conv.last_message_at || conv.created_at,
      }
    })

    /*
     * `{ conversations }`, not a bare array — see the note in
     * `app/api/mobile/categories/route.ts`. These two were the only list
     * endpoints answering `data` directly; every other answers `data.<name>`,
     * and a rule with two exceptions is a rule nobody follows.
     *
     * This is the more pointed of the two: a conversation list is the surface
     * most likely to need paging, and it had nowhere to put a cursor.
     */
    // The app has your messages now: ✓✓ delivered for their senders
    // (SCRUM-408). After the answer is built, and never allowed to fail it.
    void markInboxDelivered(authUser.userId).catch((error) =>
      logger.warn("Inbox delivery mark failed", { error: error instanceof Error ? error.message : String(error) })
    )

    return successResponse({ conversations: formattedConversations })
  } catch (error) {
    logger.error("List conversations error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to list conversations")
  }
}

// POST /api/mobile/conversations - Create or get existing conversation
export async function POST(request: NextRequest) {
  try {
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    const limited = await rateLimit(request, userLimit("heavy", "conversation-create", authUser.userId))
    if (limited) return limited

    // Not onboarded and no adult age on file: may not take part yet (SCRUM-331).
    const unfinished = await participationRefusal(authUser.userId)
    if (unfinished) return forbiddenResponse(unfinished)

    const body = await readJson(request)
    const parsed = createConversationSchema.safeParse(body)

    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }

    /*
     * A room handle only for someone the room lets you see (SCRUM-371). Every
     * conversation that makes this route succeed — a match, an accepted
     * request — already makes them identified, except a friend DM; answering
     * a handle with that DM's other side by name is how a roster would give
     * away which pseudonym is your friend.
     */
    const otherUserId = await userIdFromRefIfIdentified(authUser.userId, parsed.data.otherUserId)

    // Can't create conversation with yourself
    if (otherUserId === authUser.userId) {
      return errorResponse("Cannot create conversation with yourself")
    }

    // Check if other user exists
    const otherUser = await db.user.findUnique({
      where: { id: otherUserId },
      select: { id: true, name: true, image: true },
    })

    if (!otherUser) {
      return notFoundResponse("User not found")
    }

    /*
     * The gate. This endpoint used to create a conversation from nothing but
     * two user ids — no accepted request, no block check — so the message
     * request flow was enforced only on the screen that happened to use it, and
     * anyone who could call the API could DM anyone.
     *
     * Blocks first, and reported as "not found" rather than "blocked": telling
     * someone they have been blocked is itself information they should not have.
     */
    if (await blockedEitherWay(authUser.userId, otherUserId)) {
      return notFoundResponse("User not found")
    }

    if (!(await mayConverse(authUser.userId, otherUserId))) {
      return errorResponse("Send a message request first")
    }

    const created = await openConversation(authUser.userId, otherUserId)
    const conversation = await db.private_conversations.findUniqueOrThrow({
      where: { id: created.id },
      include: {
        user1: { select: { id: true, name: true, image: true } },
        user2: { select: { id: true, name: true, image: true } },
      },
    })

    const conversationOtherUser =
      conversation.user1_id === authUser.userId
        ? conversation.user2
        : conversation.user1

    /*
     * The same gate the GET six lines up applies, and this handler did not.
     *
     * It spread the row straight out -- `{ id, name, image }` -- so opening a
     * conversation from a match returned the other person's real name and face
     * at the moment of opening, before either side had revealed. Every other
     * surface that names a participant resolves through
     * `lib/conversation-identity.ts`; this one imported it at the top of the
     * file for the GET and then answered the question itself.
     *
     * That is the whole shape of this audit in one file: the module is right,
     * it is in scope, and using it is optional.
     */
    const otherRevealed = mayShowRealName(conversation, conversationOtherUser.id)

    return successResponse({
      id: conversation.id,
      otherUser: {
        id: conversationOtherUser.id,
        name: displayNameInConversation(
          conversation,
          conversationOtherUser.id,
          conversationOtherUser.name
        ),
        // A face identifies as surely as a name.
        image: otherRevealed ? conversationOtherUser.image : null,
      },
      fromMatch: cameFromMatch(conversation),
      theyRevealed: otherRevealed,
      createdAt: conversation.created_at,
      isNew: !conversation.last_message_at,
    })
  } catch (error) {
    // One of them left before, and leaving is permanent. The respond route
    // answers the same pair 409 with this sentence; this one said 500 and
    // logged an ERROR for an expected refusal (SCRUM-300).
    if (error instanceof ConversationClosedError) {
      return conflictResponse("This conversation was closed and cannot be reopened")
    }
    logger.error("Create conversation error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to create conversation")
  }
}
