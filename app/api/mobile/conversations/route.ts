import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { blockedEitherWay, mayConverse, openConversation } from "@/lib/conversations"
import { cameFromMatch, displayNameInConversation, mayShowRealName } from "@/lib/conversation-identity"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import {
  successResponse,
  errorResponse,
  validationErrorResponse,
  unauthorizedResponse,
  notFoundResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { z } from "zod"

const createConversationSchema = z.object({
  otherUserId: z.string().min(1, "Other user ID is required"),
})

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
        user1: {
          select: {
            id: true,
            name: true,
            image: true,
          },
        },
        user2: {
          select: {
            id: true,
            name: true,
            image: true,
          },
        },
        messages: {
          orderBy: { created_at: "desc" },
          take: 1,
          select: {
            id: true,
            message_text: true,
            sender_id: true,
            created_at: true,
            is_read: true,
          },
        },
        _count: {
          select: {
            messages: {
              where: {
                is_read: false,
                sender_id: { not: authUser.userId },
              },
            },
          },
        },
      },
      orderBy: {
        last_message_at: "desc",
      },
    })

    // Format conversations for the mobile app
    const formattedConversations = conversations.map((conv) => {
      const otherUser = conv.user1_id === authUser.userId ? conv.user2 : conv.user1
      const lastMessage = conv.messages[0] || null

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
              isRead: lastMessage.is_read,
            }
          : null,
        unreadCount: conv._count.messages,
        updatedAt: conv.last_message_at || conv.created_at,
      }
    })

    return successResponse(formattedConversations)
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

    const body = await request.json()
    const parsed = createConversationSchema.safeParse(body)

    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }

    const { otherUserId } = parsed.data

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
    logger.error("Create conversation error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to create conversation")
  }
}
