import { z } from "zod"
import { registry } from "@/lib/openapi/registry"
import { standardErrors } from "@/lib/openapi/schemas/common"
import {
  CreateConversationRequestSchema,
  SendDMRequestSchema,
  ConversationSchema,
  ConversationDetailSchema,
  CreateConversationResponseSchema,
  DMMessageSchema,
  DMMessagesResponseSchema,
} from "@/lib/openapi/schemas/chat"

const bearerAuth = [{ BearerAuth: [] }]
const wrap = (schema: z.ZodTypeAny) => z.object({ success: z.literal(true), data: schema })

// GET /api/mobile/conversations
registry.registerPath({
  method: "get",
  path: "/api/mobile/conversations",
  tags: ["Mobile Conversations"],
  summary: "List conversations",
  description: "List all direct message conversations with last message and unread count.",
  security: bearerAuth,
  responses: {
    200: { description: "Conversations", content: { "application/json": { schema: wrap(z.array(ConversationSchema)) } } },
    ...standardErrors,
  },
})

// POST /api/mobile/conversations
registry.registerPath({
  method: "post",
  path: "/api/mobile/conversations",
  tags: ["Mobile Conversations"],
  summary: "Create or get conversation",
  description: "Start a conversation with another user. Returns existing one if already exists.",
  security: bearerAuth,
  request: {
    body: { content: { "application/json": { schema: CreateConversationRequestSchema } } },
  },
  responses: {
    200: { description: "Conversation", content: { "application/json": { schema: wrap(CreateConversationResponseSchema) } } },
    ...standardErrors,
  },
})

// GET /api/mobile/conversations/{conversationId}
registry.registerPath({
  method: "get",
  path: "/api/mobile/conversations/{conversationId}",
  tags: ["Mobile Conversations"],
  summary: "Get conversation details",
  security: bearerAuth,
  request: { params: z.object({ conversationId: z.string().uuid() }) },
  responses: {
    200: { description: "Conversation detail", content: { "application/json": { schema: wrap(ConversationDetailSchema) } } },
    ...standardErrors,
  },
})

// DELETE /api/mobile/conversations/{conversationId}
registry.registerPath({
  method: "delete",
  path: "/api/mobile/conversations/{conversationId}",
  tags: ["Mobile Conversations"],
  summary: "Leave the conversation (closes it for both people)",
  description:
    "Closes the conversation for BOTH participants: it leaves both inboxes, refuses new messages, and neither person appears on the other's match cards again. It is not reversible.\n\nThis used to hard-delete the row and cascade every message, which let the subject of a report destroy the evidence against them. Rows are now retained for moderation. Old clients calling DELETE get the safe behaviour.",
  security: bearerAuth,
  request: { params: z.object({ conversationId: z.string().uuid() }) },
  responses: {
    200: { description: "Closed", content: { "application/json": { schema: wrap(z.object({ closed: z.literal(true) })) } } },
    ...standardErrors,
  },
})

// GET /api/mobile/conversations/{conversationId}/messages
registry.registerPath({
  method: "get",
  path: "/api/mobile/conversations/{conversationId}/messages",
  tags: ["Mobile Conversations"],
  summary: "Get conversation messages",
  description: "Cursor-based pagination. Pass `before` (ISO datetime) for older messages.",
  security: bearerAuth,
  request: {
    params: z.object({ conversationId: z.string().uuid() }),
    query: z.object({
      limit: z.number().optional(),
      before: z.string().datetime().optional(),
    }),
  },
  responses: {
    200: { description: "Messages", content: { "application/json": { schema: wrap(DMMessagesResponseSchema) } } },
    ...standardErrors,
  },
})

// POST /api/mobile/conversations/{conversationId}/messages
registry.registerPath({
  method: "post",
  path: "/api/mobile/conversations/{conversationId}/messages",
  tags: ["Mobile Conversations"],
  summary: "Send direct message",
  security: bearerAuth,
  request: {
    params: z.object({ conversationId: z.string().uuid() }),
    body: { content: { "application/json": { schema: SendDMRequestSchema } } },
  },
  responses: {
    200: { description: "Message sent", content: { "application/json": { schema: wrap(DMMessageSchema) } } },
    ...standardErrors,
  },
})
