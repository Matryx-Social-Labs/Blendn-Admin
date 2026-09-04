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
  method: "post",
  path: "/api/mobile/chat/groups/{chatGroupId}/messages/{messageId}/reactions",
  tags: ["Mobile Chat"],
  summary: "React to a message (toggles)",
  description:
    "One toggling call rather than add/remove: a tap is a toggle, and splitting " +
    "it puts the client in charge of knowing which state it is in — which it gets " +
    "wrong exactly when two devices disagree. The response carries `mine`; the " +
    "socket broadcast carries counts only, because the room never discloses who " +
    "reacted.",
  security: bearerAuth,
  request: {
    params: z.object({ chatGroupId: z.string(), messageId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ emoji: z.enum(["\u{1F44D}", "\u2764\uFE0F", "\u{1F602}", "\u{1F62E}", "\u{1F622}", "\u{1F525}"]) }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "The message's reactions after the toggle",
      content: {
        "application/json": {
          schema: wrap(
            z.object({
              messageId: z.string(),
              added: z.boolean(),
              reactions: z.array(
                z.object({ emoji: z.string(), count: z.number(), mine: z.boolean() })
              ),
            })
          ),
        },
      },
    },
    ...standardErrors,
  },
})

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

/*
 * Polls.
 *
 * Every count in these responses is already disclosed: `null` means WITHHELD,
 * never zero. A client that renders `null` as 0 turns "we are not telling you"
 * into "nobody voted", which is a different and false claim. `suppressedLabel`
 * carries the sentence to show instead.
 */
const PollOptionSchema = z
  .object({
    id: z.string().uuid(),
    label: z.string(),
    position: z.number().int(),
    votes: z
      .number()
      .int()
      .nullable()
      .openapi({ description: "null = withheld, NOT zero. Render `suppressedLabel`." }),
  })
  .openapi("PollOption")

const PollResultsSchema = z
  .object({
    id: z.string().uuid(),
    question: z.string(),
    closesAt: z.string().datetime().nullable(),
    closed: z.boolean(),
    resultsVisible: z
      .boolean()
      .openapi({ description: "Whether counts are published before the poll closes." }),
    options: z.array(PollOptionSchema),
    total: z.number().int().nullable().openapi({
      description:
        "null whenever ANY option was withheld — publishing the total would let a reader recover the hidden cell by subtraction.",
    }),
    suppressed: z.boolean(),
    suppressedLabel: z.string().nullable(),
    myVote: z.string().uuid().nullable().openapi({ description: "This reader's option, if any." }),
  })
  .openapi("PollResults")

// GET /api/mobile/events/{eventId}/polls/{pollId}
registry.registerPath({
  method: "get",
  path: "/api/mobile/events/{eventId}/polls/{pollId}",
  tags: ["Mobile Chat"],
  summary: "Get poll results",
  description: [
    "Counts are withheld while the poll is open unless `resultsVisible` is true, and are withheld",
    "below a floor of 5 votes per option even after it closes. Suppression is not per-cell:",
    "",
    "- any option under the floor is hidden",
    "- if anything is hidden, `total` is hidden too (otherwise you subtract to recover it)",
    "- if exactly one option would remain visible, that one is hidden as well",
    "",
    "Treat `null` as \"not reportable\". It is never zero.",
  ].join("\n"),
  security: bearerAuth,
  request: {
    params: z.object({ eventId: z.string().uuid(), pollId: z.string().uuid() }),
  },
  responses: {
    200: { description: "Poll", content: { "application/json": { schema: wrap(PollResultsSchema) } } },
    ...standardErrors,
  },
})

// POST /api/mobile/events/{eventId}/polls/{pollId}/vote
registry.registerPath({
  method: "post",
  path: "/api/mobile/events/{eventId}/polls/{pollId}/vote",
  tags: ["Mobile Chat"],
  summary: "Cast or change a vote",
  description: [
    "One vote per person, enforced by a unique on `(poll_id, user_id)`. Voting again replaces the",
    "previous choice while the poll is open — a misclick that cannot be corrected is worse than a",
    "changed mind.",
    "",
    "The response is the poll's full disclosed state, so the client renders what the server would",
    "send on a re-read rather than incrementing a count locally past the suppression floor.",
    "",
    "**409** for anything the voter can act on: poll closed, chatroom closed, not a member of the",
    "room, or an option that belongs to another poll.",
  ].join("\n"),
  security: bearerAuth,
  request: {
    params: z.object({ eventId: z.string().uuid(), pollId: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ optionId: z.string().uuid() }).openapi("PollVoteRequest"),
        },
      },
    },
  },
  responses: {
    200: { description: "Updated poll", content: { "application/json": { schema: wrap(PollResultsSchema) } } },
    409: { description: "Poll closed, room closed, not a member, or unknown option" },
    ...standardErrors,
  },
})
