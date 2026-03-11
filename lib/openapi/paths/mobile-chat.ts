import { z } from "zod"
import { registry } from "@/lib/openapi/registry"
import { standardErrors } from "@/lib/openapi/schemas/common"
import {
  SendMessageRequestSchema,
  ChatMessageSchema,
  ChatGroupListResponseSchema,
  GroupMessagesResponseSchema,
  ParticipantsResponseSchema,
} from "@/lib/openapi/schemas/chat"

const bearerAuth = [{ BearerAuth: [] }]
const wrap = (schema: z.ZodTypeAny) => z.object({ success: z.literal(true), data: schema })

// GET /api/mobile/chat/groups
registry.registerPath({
  method: "get",
  path: "/api/mobile/chat/groups",
  tags: ["Mobile Chat"],
  summary: "List chat groups",
  description: "List all chat groups the user is a member of, with last message and unread count.",
  security: bearerAuth,
  request: {
    query: z.object({
      page: z.number().optional(),
      limit: z.number().optional(),
    }),
  },
  responses: {
    200: { description: "Chat groups", content: { "application/json": { schema: wrap(ChatGroupListResponseSchema) } } },
    ...standardErrors,
  },
})

// GET /api/mobile/chat/groups/{chatGroupId}/messages
registry.registerPath({
  method: "get",
  path: "/api/mobile/chat/groups/{chatGroupId}/messages",
  tags: ["Mobile Chat"],
  summary: "Get group messages",
  description: "Cursor-based pagination. Pass `before` (message UUID) to load older messages.",
  security: bearerAuth,
  request: {
    params: z.object({ chatGroupId: z.string().uuid() }),
    query: z.object({
      limit: z.number().optional(),
      before: z.string().uuid().optional().openapi({ description: "Cursor: message ID to paginate before" }),
    }),
  },
  responses: {
    200: { description: "Messages", content: { "application/json": { schema: wrap(GroupMessagesResponseSchema) } } },
    ...standardErrors,
  },
})

// POST /api/mobile/chat/groups/{chatGroupId}/messages
registry.registerPath({
  method: "post",
  path: "/api/mobile/chat/groups/{chatGroupId}/messages",
  tags: ["Mobile Chat"],
  summary: "Send group message",
  security: bearerAuth,
  request: {
    params: z.object({ chatGroupId: z.string().uuid() }),
    body: { content: { "application/json": { schema: SendMessageRequestSchema } } },
  },
  responses: {
    201: { description: "Message sent", content: { "application/json": { schema: wrap(ChatMessageSchema) } } },
    ...standardErrors,
  },
})

// GET /api/mobile/chat/groups/{chatGroupId}/participants
registry.registerPath({
  method: "get",
  path: "/api/mobile/chat/groups/{chatGroupId}/participants",
  tags: ["Mobile Chat"],
  summary: "List group participants",
  security: bearerAuth,
  request: {
    params: z.object({ chatGroupId: z.string().uuid() }),
    query: z.object({
      limit: z.number().optional(),
      offset: z.number().optional(),
    }),
  },
  responses: {
    200: { description: "Participants", content: { "application/json": { schema: wrap(ParticipantsResponseSchema) } } },
    ...standardErrors,
  },
})
