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
  description: "List the rooms the user is a member of, with last message and unread count. `groups`: event and venue-day rooms, paged, each `kind: \"event\"` with its `event`. `rooms`: the user's crews' chats and their Blends' rooms while open (`kind` `crew` or `blend`, with `crewId`/`blendId`), not paged — a person is in at most ten crews and a night's few Blends — so sent with page 1 and `[]` after. No preview, unread count or `rooms` time comes from somebody in a block with the caller. A board post's room is not listed.",
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
  description: "Messages are the stored rows, snake_case (`created_at`, `is_edited`, `parent_message`, `_count.replies`) — not the camelCase `ChatMessage` of `GET /events/{eventId}/chat`. Cursor-based pagination. Pass `before` (message UUID) to load older messages. Moderation-hidden messages are included for the sender only, with `content: null` and `moderation_hidden: true` — render these as placeholders. Readable by an `active`, `muted` or `left` member. A `banned` member gets 403 `USER_BANNED` with a sentence saying who removed them; a draft (hidden) event's room answers 404 — the same rule the socket join applies.",
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

const RoomParams = z.object({ chatGroupId: z.string().uuid() })
const LeaveResultSchema = z.object({ chatGroupId: z.string().uuid(), left: z.boolean() })
const MuteResultSchema = z.object({
  chatGroupId: z.string().uuid(),
  mute: z.object({ muted: z.boolean(), until: z.string().datetime().nullable() }),
})
const ROOM_404 =
  "404 `NOT_FOUND` for a malformed id, an unknown room, a draft or deleted event's room, a room whose owner does not admit you (a room of any kind — `chat_groups.kind`), or a room you have no membership in — one answer for all, so this cannot be used to learn which rooms exist. "

// POST + DELETE /api/mobile/chat/groups/{chatGroupId}/leave
registry.registerPath({
  method: "post",
  path: "/api/mobile/chat/groups/{chatGroupId}/leave",
  tags: ["Mobile Chat"],
  summary: "Leave a room",
  description:
    "Marks your membership `left` (the row is kept: your pseudonym on past messages resolves through it). From then on the room is closed to you: " +
    "`GET /events/{eventId}/chat` answers 403 `LEFT_ROOM` (with `chatGroupId`) instead of rejoining you, history/participants/polls answer 403 as for a non-member, " +
    "posts and reactions answer 403 `LEFT_ROOM`, the socket join is refused, and no push from the room reaches you. " +
    "Your live sockets are taken out of `chat:{id}` and the room gets `chat:memberLeft`.\n\n" +
    "**Rejoining:** checking in to the event again rejoins you, or `DELETE` this path. Opening the room does not. " +
    "Idempotent — leaving again, or leaving a room you were released from or banned from, is the same 200 and tells nobody twice. " +
    ROOM_404,
  security: bearerAuth,
  request: { params: RoomParams },
  responses: {
    200: { description: "Left", content: { "application/json": { schema: wrap(LeaveResultSchema) } } },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "delete",
  path: "/api/mobile/chat/groups/{chatGroupId}/leave",
  tags: ["Mobile Chat"],
  summary: "Rejoin a room you left",
  description:
    "Undoes a leave you made yourself, while the room is open. Muted by the organiser when you left? You come back muted. " +
    "403 `USER_BANNED` for a ban; 403 `CHAT_CLOSED` / `CHAT_LOCKED` when the room's window has shut or it was released by the lifecycle sweeper. " +
    "Idempotent — rejoining a room you never left answers 200 `{ left: false }`. " +
    ROOM_404,
  security: bearerAuth,
  request: { params: RoomParams },
  responses: {
    200: { description: "In the room", content: { "application/json": { schema: wrap(LeaveResultSchema) } } },
    ...standardErrors,
  },
})

// POST + DELETE /api/mobile/chat/groups/{chatGroupId}/mute
registry.registerPath({
  method: "post",
  path: "/api/mobile/chat/groups/{chatGroupId}/mute",
  tags: ["Mobile Chat"],
  summary: "Mute a room's notifications",
  description:
    "Stops the room's pushes to you — a reply to you, an organiser's announcement (and its bell row). You still read and post; nobody is told. " +
    "Not the organiser's mute, which stops a person posting. Optional `until` (ISO 8601, future, at most a year away); omit or null for until you unmute. " +
    "Posting again replaces `until`. The state is also returned as `mute` by `GET /events/{eventId}/chat` and on each `GET /chat/groups` item. " +
    ROOM_404,
  security: bearerAuth,
  request: {
    params: RoomParams,
    body: {
      required: false,
      content: {
        "application/json": { schema: z.object({ until: z.string().datetime({ offset: true }).nullable().optional() }) },
      },
    },
  },
  responses: {
    200: { description: "Muted", content: { "application/json": { schema: wrap(MuteResultSchema) } } },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "delete",
  path: "/api/mobile/chat/groups/{chatGroupId}/mute",
  tags: ["Mobile Chat"],
  summary: "Unmute a room",
  description: "Idempotent. " + ROOM_404,
  security: bearerAuth,
  request: { params: RoomParams },
  responses: {
    200: { description: "Unmuted", content: { "application/json": { schema: wrap(MuteResultSchema) } } },
    ...standardErrors,
  },
})

// POST /api/mobile/chat/groups/{chatGroupId}/report
registry.registerPath({
  method: "post",
  path: "/api/mobile/chat/groups/{chatGroupId}/report",
  tags: ["Mobile Safety"],
  summary: "Report a room",
  description:
    "For what no single message shows — a pile-on, a room gone hostile. Same body as the other reports. Members only, any status: somebody who left or was " +
    "banned may need this most. A room whose event was taken down is still reportable. Lands in the admin reports queue as \"Room\". " +
    "404 `NOT_FOUND` for a malformed id, an unknown room, a room you were never in, or a room that is not an event's (a report is filed against the room's event; report its messages instead).",
  security: bearerAuth,
  request: {
    params: RoomParams,
    body: {
      content: {
        "application/json": {
          schema: z.object({ reason: z.string().min(1).max(200), description: z.string().max(2000).optional() }),
        },
      },
    },
  },
  responses: {
    201: { description: "Report filed", content: { "application/json": { schema: wrap(z.object({ reported: z.literal(true) })) } } },
    ...standardErrors,
  },
})

// GET /api/mobile/chat/groups/{chatGroupId}/participants
registry.registerPath({
  method: "get",
  path: "/api/mobile/chat/groups/{chatGroupId}/participants",
  tags: ["Mobile Chat"],
  summary: "List group participants",
  description: "Readable by an `active`, `muted` or `left` member. A `banned` member gets 403 `USER_BANNED` with a sentence saying who removed them; a draft (hidden) event's room answers 404 — the same rule the socket join applies. In a room that is not an event's (a board post's), only the people its owner admits are listed.",
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
    "",
    "Read by the room, with the room's own read rule: **404** when the poll is not in the event",
    "named in the URL, its message was deleted, or the event is a draft; **403** for somebody who",
    "was never in the room and for a member who was banned from it. `muted` and `left` members",
    "still read.",
  ].join("\n"),
  security: bearerAuth,
  request: {
    params: z.object({ eventId: z.string().uuid(), pollId: z.string().uuid() }),
  },
  responses: {
    ...standardErrors,
    200: { description: "Poll", content: { "application/json": { schema: wrap(PollResultsSchema) } } },
    403: { description: "Not in the room, or removed from it" },
    404: { description: "No such poll in this event, its message deleted, or the event is a draft" },
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
    ...standardErrors,
    200: { description: "Updated poll", content: { "application/json": { schema: wrap(PollResultsSchema) } } },
    404: { description: "No such poll in this event" },
    409: { description: "Poll closed, room closed, not a member, or unknown option" },
  },
})
