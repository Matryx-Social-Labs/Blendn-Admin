import { z } from "zod"
import { registry } from "@/lib/openapi/registry"
import { ListPaginationSchema, ListQuerySchema, PARTICIPATION_GATE, standardErrors, wrap, bearerAuth } from "@/lib/openapi/schemas/common"
import {
  CreateConversationRequestSchema,
  SendDMRequestSchema,
  ConversationSchema,
  ConversationDetailSchema,
  CreateConversationResponseSchema,
  DMMessageSchema,
  DMMessagesResponseSchema,
} from "@/lib/openapi/schemas/chat"

// GET /api/mobile/conversations
registry.registerPath({
  method: "get",
  path: "/api/mobile/conversations",
  tags: ["Mobile Conversations"],
  summary: "List conversations",
  description:
    "Direct message conversations with last message and unread count, newest first, a page at a time: " +
    "`?limit=` and `?cursor=`: without `limit` or `cursor` (installed builds, which cannot page) up to 200; " +
    "otherwise default 50, 1-100. `pagination.nextCursor` and `pagination.totalCount` say what is left. A " +
    "conversation with nothing said yet leads, then the rest by last message; `lastMessage` is the newest " +
    "message the thread would show.",
  security: bearerAuth,
  request: { query: ListQuerySchema },
  responses: {
    // `data.conversations`, matching every other list endpoint. It was a bare
    // array; two exceptions to a rule is a rule nobody follows, and a bare
    // array has nowhere to put a cursor.
    200: {
      description: "Conversations",
      content: {
        "application/json": {
          schema: wrap(z.object({ conversations: z.array(ConversationSchema), pagination: ListPaginationSchema })),
        },
      },
    },
    ...standardErrors,
  },
})

// POST /api/mobile/conversations
registry.registerPath({
  method: "post",
  path: "/api/mobile/conversations",
  tags: ["Mobile Conversations"],
  summary: "Create or get conversation",
  description:
    PARTICIPATION_GATE +
    "Start a conversation with another user. Returns existing one if already exists. Needs an accepted message request. A pair that was closed (unmatch, leave, block) stays closed: **409**.",
  security: bearerAuth,
  request: {
    body: { content: { "application/json": { schema: CreateConversationRequestSchema } } },
  },
  responses: {
    ...standardErrors,
    200: { description: "Conversation", content: { "application/json": { schema: wrap(CreateConversationResponseSchema) } } },
    409: { description: "This conversation was closed and cannot be reopened" },
  },
})

// POST /api/mobile/conversations/read
registry.registerPath({
  method: "post",
  path: "/api/mobile/conversations/read",
  tags: ["Mobile Conversations"],
  summary: "Mark all conversations read",
  description:
    "The inbox's \"Mark all read\". Marks exactly what `GET /conversations` counts as unread: the other person's visible messages, in the caller's live conversations.",
  security: bearerAuth,
  responses: {
    200: {
      description: "Marked",
      content: { "application/json": { schema: wrap(z.object({ marked: z.number().int() })) } },
    },
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

// POST /api/mobile/conversations/{conversationId}/leave
registry.registerPath({
  method: "post",
  path: "/api/mobile/conversations/{conversationId}/leave",
  tags: ["Mobile Conversations"],
  summary: "Leave the conversation, optionally blocking and reporting, in one call",
  description:
    "Closes the conversation for BOTH participants, permanently. `action: \"block\"` also hides that person from your event rooms and cancels pending requests both ways.\n\nThe optional `report` is filed in the SAME transaction. That is the point of this route existing alongside DELETE: composing close and report on the client can half-fail into a closed thread whose evidence is out of reach, which is the state the design exists to prevent.\n\nOmit `report.messageId` to report the person rather than a specific message. Over 30 reports in a day, the leave and block still happen and the report is dropped (`reportAccepted: false`); never a 429.",
  security: bearerAuth,
  request: {
    params: z.object({ conversationId: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            action: z.enum(["unmatch", "block"]).default("unmatch"),
            report: z
              .object({
                reason: z.string().min(1).max(200),
                description: z.string().max(2000).optional(),
                messageId: z.string().uuid().optional(),
              })
              .optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Closed",
      content: {
        "application/json": {
          schema: wrap(
            z.object({
              closed: z.literal(true),
              blocked: z.boolean(),
              reported: z.boolean(),
              reportAccepted: z.boolean().describe("False only when a report was sent and the 30-a-day report allowance had run out: the leave and block still happened, the report was dropped."),
            })
          ),
        },
      },
    },
    ...standardErrors,
  },
})

// POST /api/mobile/conversations/{conversationId}/reveal
registry.registerPath({
  method: "post",
  path: "/api/mobile/conversations/{conversationId}/reveal",
  tags: ["Mobile Conversations"],
  summary: "Show your name and photos, or ask the other person to",
  description:
    "Each side reveals independently -- it is a standing offer, not a trade, so going first does not expose the other person and waiting is not a refusal. It is NOT retractable: nothing can unsee a name and a face, and there is no path back to false.\n\n`{ ask: true }` asks the other person instead. That is one boolean on their side, which makes it un-naggable (asking twice writes the same value) and means there is deliberately NO decline -- a decline delivers a rejection, which is the thing this product exists to remove. Asking someone already revealed is a 400.\n\nRevealing without a name and a photo is refused with `reveal_incomplete`: the switch would otherwise turn on and show the other person nothing at all.",
  security: bearerAuth,
  request: {
    params: z.object({ conversationId: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ ask: z.boolean().optional() }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Revealed, or the request recorded",
      content: {
        "application/json": {
          schema: wrap(
            z.object({
              revealed: z.boolean().optional(),
              mutual: z.boolean().optional(),
              requested: z.boolean().optional(),
            })
          ),
        },
      },
    },
    ...standardErrors,
  },
})

// GET /api/mobile/conversations/{conversationId}/messages
registry.registerPath({
  method: "get",
  path: "/api/mobile/conversations/{conversationId}/messages",
  tags: ["Mobile Conversations"],
  summary: "Get conversation messages",
  description: "Cursor-based pagination. Pass `before` (ISO datetime) for older messages. A message the keyword filter hid is returned to its sender only, as a removed message: `moderation_hidden: true`, `text`/`mediaUrl`/`replyTo` null, `isRead` false, `deliveredAt` null, `mediaType` kept. The recipient never receives it.",
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
  description:
    PARTICIPATION_GATE +
    "Screened by the deterministic checks -- keyword, spam and contact details -- and by no model. A model check would send an unreviewed private message to a third party and, on a hit, make it something a human may read; nothing here is read by anybody unless the recipient reports it.\n\nSpam is REFUSED with 429 `SPAM_BLOCKED`, because a flood is the one failure the recipient feels immediately. It is counted per conversation, so messaging ten people is not throttled as flooding one.\n\nA message the keyword filter catches is stored, never delivered, and the response carries `moderation_hidden: true` with `text: null`. The sender is told rather than left to conclude they were ignored. It is excluded from the recipient's thread, the inbox preview and the unread count (the sender still sees it as removed on `GET`), and it is still stored -- `moderation_flags.message_id` is a NOT NULL foreign key to `chat_messages`, so a flag against a DM is impossible and the row is the only record a report can rest on.\n\nContact details are flagged and DELIVERED. Refusing teaches the sender where the boundary is, and the next attempt is spelled out with nothing behind it.",
  security: bearerAuth,
  request: {
    params: z.object({ conversationId: z.string().uuid() }),
    body: { content: { "application/json": { schema: SendDMRequestSchema } } },
  },
  responses: {
    200: {
      description: "Sent, or stored and hidden (`moderation_hidden: true`, `text: null`)",
      content: {
        "application/json": {
          schema: wrap(
            DMMessageSchema.and(z.object({ moderation_hidden: z.boolean().optional() }))
          ),
        },
      },
    },
    ...standardErrors,
  },
})
