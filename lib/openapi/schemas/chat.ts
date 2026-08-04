import { z } from "zod"
import { registry } from "@/lib/openapi/registry"
import { PaginationMetaSchema } from "./common"

// Request schemas
export const SendMessageRequestSchema = z
  .object({
    content: z.string().min(1).max(4000),
    type: z.enum(["text", "image", "video"]).default("text"),
    parentId: z.string().uuid().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi("SendMessageRequest")

export const SendDMRequestSchema = z
  .object({
    text: z.string().max(5000).optional(),
    mediaUrl: z.string().url().optional(),
    mediaType: z.enum(["image", "video"]).optional(),
  })
  .openapi("SendDMRequest")

export const CreateConversationRequestSchema = z
  .object({
    otherUserId: z.string().uuid(),
  })
  .openapi("CreateConversationRequest")

// Response schemas
const ChatUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  image: z.string().nullable(),
})

const ReactionSchema = z.object({
  emoji: z.string(),
  userId: z.string(),
  userName: z.string().optional(),
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
    user: ChatUserSchema,
    reactions: z.array(ReactionSchema),
    isOwn: z.boolean().optional(),
  })
  .openapi("ChatMessage")

export const EventChatResponseSchema = z
  .object({
    chatGroupId: z.string().uuid(),
    chatGroupName: z.string(),
    messages: z.array(ChatMessageSchema),
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
    lastMessageAt: z.string().datetime().nullable(),
    lastMessage: z
      .object({
        id: z.string().uuid(),
        content: z.string(),
        createdAt: z.string().datetime(),
        user: z.object({ id: z.string(), name: z.string() }),
      })
      .nullable(),
    event: z.object({
      id: z.string().uuid(),
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
    }),
  })
  .openapi("ChatGroup")

export const ChatGroupListResponseSchema = z
  .object({
    groups: z.array(ChatGroupSchema),
    pagination: PaginationMetaSchema,
  })
  .openapi("ChatGroupListResponse")

export const GroupMessagesResponseSchema = z
  .object({
    messages: z.array(ChatMessageSchema),
    pagination: z.object({
      hasMore: z.boolean(),
      nextCursor: z.string().nullable(),
    }),
  })
  .openapi("GroupMessagesResponse")

export const ParticipantSchema = z
  .object({
    userId: z.string(),
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
  EventChatResponse: EventChatResponseSchema,
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
