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
  description: "Cursor-based pagination. Pass `before` (message UUID) to load older messages. Moderation-hidden messages are included for the sender only, with `content: null` and `moderation_hidden: true` — render these as placeholders.",
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
  description: [
    "Send a message to a chat group. Messages go through a moderation pipeline **before** being broadcast:",
    "",
    "1. **Spam check** — blocks if burst rate exceeded (5 msgs/10s) or 3+ links",
    "2. **Keyword filter** — instant block for slurs/profanity in 9 languages",
    "3. **OpenAI Moderation** — AI content analysis with 1s timeout (falls back to async if slow)",
    "",
    "If moderation catches the message, the response has `moderation_hidden: true` and `content: null`.",
    "The message is never broadcast to other users via socket.",
    "",
    "**Error codes:** `USER_MUTED` (403), `USER_BANNED` (403), `CHAT_LOCKED` (403), `NOT_CHECKED_IN` (403), `SPAM_BLOCKED` (429)",
  ].join("\n"),
  security: bearerAuth,
  request: {
    params: z.object({ chatGroupId: z.string().uuid() }),
    body: { content: { "application/json": { schema: SendMessageRequestSchema } } },
  },
  responses: {
    201: { description: "Message sent (check `moderation_hidden` — if true, content was blocked)", content: { "application/json": { schema: wrap(ChatMessageSchema) } } },
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
