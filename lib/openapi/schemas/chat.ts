import { z } from "zod"
import { registry } from "@/lib/openapi/registry"
import { PaginationMetaSchema, RoomUserRefSchema, UserRefParamSchema } from "./common"

// Request schemas
export const SendMessageRequestSchema = z
  .object({
    content: z.string().min(1).max(4000),
    type: z.enum(["text", "image", "video"]).default("text"),
    parentId: z.string().uuid().optional(),
    metadata: z
      .object({
        mediaUrl: z.string().url().optional().openapi({
          description: "The sender's own chat upload (POST /uploads/presigned-url, folder chat). Any other URL is 400.",
        }),
      })
      .strict()
      .optional()
      .openapi({ description: "Only `mediaUrl`. Any other key is refused (400): the server writes the rest (SCRUM-426)." }),
  })
  .openapi("SendMessageRequest")

export const SendDMRequestSchema = z
  .object({
    text: z.string().max(5000).optional(),
    mediaUrl: z.string().url().optional().openapi({
      description: "The sender's own chat upload (POST /uploads/presigned-url, folder chat). Any other URL is 400 (SCRUM-426).",
    }),
    mediaType: z.enum(["image", "video"]).optional(),
  })
  .openapi("SendDMRequest")

export const CreateConversationRequestSchema = z
  .object({
    otherUserId: UserRefParamSchema.openapi({
      description:
        "A user id, or a room handle for someone the caller may already see (`identityVisible`). Any other handle is answered as an unknown user (SCRUM-371).",
    }),
  })
  .openapi("CreateConversationRequest")

// Response schemas
const ChatUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  image: z.string().nullable(),
})

/** A message author in a room: yours real, anybody else's a room handle. */
const RoomChatUserSchema = ChatUserSchema.extend({ id: RoomUserRefSchema })

/**
 * A tally, not a roster.
 *
 * This carried `userId` and `userName`, which `docs/CHAT.md:119` forbids —
 * "reactions show the count only, never who — who reacted is exactly the kind
 * of thing this room does not disclose". The client already rendered only the
 * emoji and a tally, so the disclosure was in the payload and nowhere on the
 * screen, which is the version that survives review.
 */
const ReactionSchema = z.object({
  emoji: z.string(),
  count: z.number().openapi({ description: "How many people reacted with this emoji." }),
  mine: z
    .boolean()
    .openapi({ description: "Whether the authenticated caller is one of them." }),
})

export const ChatMessageSchema = z
  .object({
    id: z.string().uuid(),
    type: z.string(),
    content: z.string().nullable().openapi({ description: "Message text. Null when moderation_hidden is true." }),
    moderation_hidden: z.boolean().optional().openapi({ description: "True if this message was hidden by moderation. Content will be null. Only returned to the message sender." }),
    metadata: z.unknown().nullable(),
    isEdited: z.boolean(),
    isPinned: z.boolean(),
    createdAt: z.string().datetime(),
    editedAt: z.string().datetime().nullable().optional(),
    parentId: z.string().uuid().nullable(),
    replyCount: z.number().optional(),
    user: RoomChatUserSchema,
    reactions: z.array(ReactionSchema),
    isOwn: z.boolean().optional(),
  })
  .openapi("ChatMessage")

/** Your own mute of a room's pushes (`POST /chat/groups/{id}/mute`). Not the organiser's mute. */
export const RoomMuteSchema = z
  .object({
    muted: z.boolean(),
    until: z
      .string()
      .datetime()
      .nullable()
      .describe("When the mute lapses. Null with `muted: true` means until you unmute; always null when not muted."),
  })
  .openapi("RoomMute")

/** Whether the room takes writes from the caller, and why not (`mayWriteToRoom`, `lib/chat-window.ts`). */
export const RoomWriteSchema = z
  .object({
    allowed: z.boolean(),
    reason: z
      .enum(["archived", "locked", "window_closed", "not_open_yet", "hidden", "not_live", "muted", "banned", "left"])
      .nullable()
      .describe("Null when `allowed`."),
    message: z
      .string()
      .nullable()
      .describe("A sentence for the composer. Null when allowed, and for `muted`, `banned` and `left`."),
    closesAt: z
      .string()
      .datetime()
      .describe("When the 24-hour window after the event shuts. A venue day's room closes at its reset instead."),
    eventEndedAt: z.string().datetime().describe("Past this, the room is a read-only record of the night."),
  })
  .openapi("RoomWrite")

export const EventChatResponseSchema = z
  .object({
    chatGroupId: z.string().uuid(),
    chatGroupName: z.string(),
    write: RoomWriteSchema,
    mute: RoomMuteSchema,
    // Every key is sent on this read, the ones ChatMessage leaves optional too.
    messages: z.array(
      ChatMessageSchema.extend({
        moderation_hidden: z.boolean(),
        editedAt: z.string().datetime().nullable(),
        replyCount: z.number().int(),
        isOwn: z.boolean(),
      })
    ),
    pagination: PaginationMetaSchema,
  })
  .openapi("EventChatResponse")

export const ChatGroupSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    type: z.string(),
    memberCount: z.number(),
    unreadCount: z.number(),
    mute: RoomMuteSchema,
    lastMessageAt: z.string().datetime().nullable(),
    fromMatch: z
      .boolean()
      .describe(
        "Opened from a mutual like rather than an accepted message request. Not derivable client-side: `theyRevealed` is true for BOTH a never-pseudonymous conversation and a revealed match, so it cannot tell them apart."
      ),
    lastMessage: z
      .object({
        id: z.string().uuid(),
        content: z.string(),
        createdAt: z.string().datetime(),
        user: z.object({ id: RoomUserRefSchema, name: z.string() }),
      })
      .nullable(),
    event: z.object({
      id: z.string().uuid(),
      kind: z
        .enum(["event", "venue_day"])
        .describe("`venue_day`: a place's room (listed only while your Go Live there is open). Name it by the room's `name`, the place; its `title` is bookkeeping."),
      slug: z.string(),
      title: z.string(),
      coverImageUrl: z.string().nullable(),
      startTime: z.string().datetime(),
      endTime: z.string().datetime(),
      status: z.string(),
    }),
    membership: z.object({
      role: z.string(),
      joinedAt: z.string().datetime(),
      status: z
        .enum(["active", "muted"])
        .describe("`muted`: the caller can read this room but a post is refused. Banned and left memberships are not listed."),
    }),
    status: z
      .enum(["active", "locked"])
      .describe("`locked`: read-only for everyone until the organiser reopens it. Archived rooms are not listed."),
    isCheckedIn: z
      .boolean()
      .describe(
        "The caller is checked in to this room's event and has not checked out — the room is live. Not derivable client-side: an event being underway is not the same as the caller being there."
      ),
  })
  .openapi("ChatGroup")

export const ChatGroupListResponseSchema = z
  .object({
    groups: z.array(ChatGroupSchema),
    pagination: PaginationMetaSchema,
  })
  .openapi("ChatGroupListResponse")

/**
 * The stored `chat_messages` row, snake_case, with its includes — not the
 * camelCase `ChatMessage` that `GET /events/{eventId}/chat` builds.
 */
export const GroupChatMessageSchema = z
  .object({
    id: z.string().uuid(),
    chat_group_id: z.string().uuid(),
    user_id: RoomUserRefSchema,
    parent_id: z.string().uuid().nullable(),
    type: z.enum(["text", "image", "video", "system", "sponsored", "announcement", "poll"]),
    content: z.string().nullable().describe("Null when `moderation_hidden`."),
    metadata: z.unknown().nullable(),
    is_edited: z.boolean(),
    edited_at: z.string().datetime().nullable(),
    is_pinned: z.boolean(),
    client_id: z.string().uuid().nullable().describe("The sender's own id for the send (SCRUM-410)."),
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    deleted_at: z.string().datetime().nullable(),
    deleted_by: RoomUserRefSchema.nullable(),
    moderation_status: z.string().nullable().describe("`clean`, `flagged` or `hidden`; null when never examined."),
    moderation_hidden: z.boolean(),
    user: RoomChatUserSchema,
    reactions: z.array(ReactionSchema),
    parent_message: z
      .object({
        id: z.string().uuid(),
        type: z.string(),
        metadata: z.unknown().nullable(),
        content: z.string().nullable(),
        moderation_hidden: z
          .boolean()
          .describe("The quoted message was taken down: its content and metadata are null (SCRUM-444)."),
        user: z.object({ id: RoomUserRefSchema, name: z.string() }),
      })
      .nullable()
      .describe("The message this one replies to."),
    _count: z.object({ replies: z.number().int() }),
  })
  .openapi("GroupChatMessage")

export const GroupMessagesResponseSchema = z
  .object({
    messages: z.array(GroupChatMessageSchema),
    pagination: z.object({
      hasMore: z.boolean(),
      nextCursor: z.string().nullable(),
    }),
  })
  .openapi("GroupMessagesResponse")

export const ParticipantSchema = z
  .object({
    userId: RoomUserRefSchema,
    name: z.string(),
    avatar: z.string().nullable(),
    role: z.string(),
    status: z.string(),
    joinedAt: z.string().datetime(),
  })
  .openapi("Participant")

export const ParticipantsResponseSchema = z
  .object({
    participants: z.array(ParticipantSchema),
    totalCount: z.number(),
  })
  .openapi("ParticipantsResponse")

// Conversation response schemas
export const ConversationSchema = z
  .object({
    id: z.string().uuid(),
    otherUser: ChatUserSchema,
    fromMatch: z.boolean().describe("Opened from a mutual like rather than an accepted message request."),
    pseudonymous: z
      .boolean()
      .describe(
        "Whether there is anything left to reveal. False for an accepted message request — real names from the start — so the client draws no reveal header on it."
      ),
    youRevealed: z.boolean(),
    theyRevealed: z.boolean(),
    revealRequested: z.boolean(),
    lastMessage: z
      .object({
        id: z.string().uuid(),
        text: z.string().nullable(),
        senderId: z.string(),
        createdAt: z.string().datetime(),
        isRead: z.boolean(),
      })
      .nullable(),
    unreadCount: z.number(),
    updatedAt: z.string().datetime(),
  })
  .openapi("Conversation")

export const ConversationDetailSchema = z
  .object({
    id: z.string().uuid(),
    otherUser: ChatUserSchema,
    createdAt: z.string().datetime(),
    lastMessageAt: z.string().datetime().nullable(),
  })
  .openapi("ConversationDetail")

export const CreateConversationResponseSchema = z
  .object({
    id: z.string().uuid(),
    otherUser: ChatUserSchema,
    createdAt: z.string().datetime(),
    isNew: z.boolean(),
  })
  .openapi("CreateConversationResponse")

export const DMMessageSchema = z
  .object({
    id: z.string().uuid(),
    conversationId: z.string().uuid(),
    senderId: z.string(),
    sender: ChatUserSchema,
    text: z.string().nullable(),
    mediaUrl: z.string().nullable(),
    mediaType: z.string().nullable(),
    isRead: z.boolean(),
    createdAt: z.string().datetime(),
  })
  .openapi("DMMessage")

export const DMMessagesResponseSchema = z
  .object({
    messages: z.array(DMMessageSchema),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  })
  .openapi("DMMessagesResponse")

// Register all
const schemas = {
  SendMessageRequest: SendMessageRequestSchema,
  SendDMRequest: SendDMRequestSchema,
  CreateConversationRequest: CreateConversationRequestSchema,
  ChatMessage: ChatMessageSchema,
  RoomWrite: RoomWriteSchema,
  EventChatResponse: EventChatResponseSchema,
  GroupChatMessage: GroupChatMessageSchema,
  ChatGroup: ChatGroupSchema,
  ChatGroupListResponse: ChatGroupListResponseSchema,
  GroupMessagesResponse: GroupMessagesResponseSchema,
  Participant: ParticipantSchema,
  ParticipantsResponse: ParticipantsResponseSchema,
  Conversation: ConversationSchema,
  ConversationDetail: ConversationDetailSchema,
  CreateConversationResponse: CreateConversationResponseSchema,
  DMMessage: DMMessageSchema,
  DMMessagesResponse: DMMessagesResponseSchema,
}

for (const [name, schema] of Object.entries(schemas)) {
  registry.register(name, schema)
}
