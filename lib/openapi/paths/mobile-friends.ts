import { z } from "zod"
import { registry } from "@/lib/openapi/registry"
import { PARTICIPATION_GATE, standardErrors } from "@/lib/openapi/schemas/common"

/*
 * Friends. Two rules shape every route here (see lib/friends.ts):
 * nobody can be looked up — every refusal a stranger can reach is the same
 * 404 — and friends are still pseudonyms in a room unless they turn on
 * `friends_see_me_in_rooms`.
 */

const bearerAuth = [{ bearerAuth: [] }]
const wrap = (schema: z.ZodTypeAny) => z.object({ success: z.literal(true), data: schema })
const tags = ["Mobile Friends"]

const SAME_404 =
  "Every refusal a stranger could reach — unknown, malformed or reset token, deleted account, a block either way, " +
  "a pair who left each other, a user id you have no relationship with — answers with the same 404, so nothing here " +
  "tells anyone whether a person uses the app. "

const PersonSchema = z
  .object({
    userId: z.string(),
    name: z.string(),
    photo: z.string().nullable(),
  })
  .openapi("FriendPerson")

const FriendStateSchema = z.enum(["self", "friends", "requested", "incoming", "none"]).openapi("FriendState")

const InviteSchema = z
  .object({
    token: z.string().describe("22 characters, base64url, 128 bits"),
    url: z.string().describe("https://www.blendn.app/f/<token> — www, because the apex redirects"),
  })
  .openapi("FriendInvite")

const RequestItemSchema = z
  .object({ id: z.string().uuid(), person: PersonSchema, createdAt: z.string() })
  .openapi("FriendRequestItem")

registry.registerPath({
  method: "get",
  path: "/api/mobile/friends",
  tags,
  summary: "List my friends",
  description: "Newest first, with the count the Me tab shows. Real names and photos: both people said yes.",
  security: bearerAuth,
  responses: {
    200: {
      description: "Friends",
      content: {
        "application/json": {
          schema: wrap(
            z.object({
              friends: z.array(PersonSchema.extend({ since: z.string() })),
              count: z.number().int(),
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
  path: "/api/mobile/friends/{userId}",
  tags,
  summary: "A friend's profile",
  description:
    "The identified profile, for a friend only; 404 for anyone else whether or not they exist. Separate from " +
    "`GET /users/{userId}`, which is what a room card opens — a friend there is still a pseudonym. " +
    "`conversationId` is an open DM, if there is one.",
  security: bearerAuth,
  request: { params: z.object({ userId: z.string() }) },
  responses: {
    200: {
      description: "Friend",
      content: {
        "application/json": {
          schema: wrap(
            z.object({
              userId: z.string(),
              name: z.string(),
              photos: z.array(z.string()),
              bio: z.string().nullable(),
              occupation: z.string().nullable(),
              education: z.string().nullable(),
              age: z.number().int().nullable(),
              location: z.string().nullable(),
              interests: z.array(z.object({ id: z.string(), name: z.string(), slug: z.string(), icon: z.string().nullable() })),
              friendsSince: z.string(),
              conversationId: z.string().uuid().nullable(),
            })
          ),
        },
      },
    },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "delete",
  path: "/api/mobile/friends/{userId}",
  tags,
  summary: "Unfriend",
  description: "Silent — nobody is told — and any DM is left alone. Idempotent.",
  security: bearerAuth,
  request: { params: z.object({ userId: z.string() }) },
  responses: {
    200: { description: "Removed", content: { "application/json": { schema: wrap(z.object({ removed: z.literal(true) })) } } },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "post",
  path: "/api/mobile/friends/{userId}/conversation",
  tags,
  summary: "Open a DM with a friend",
  description:
    PARTICIPATION_GATE +
    "No shared event needed. Returns the existing conversation if there is one; a new one is marked as opened " +
    "between friends, so it does not make either of you recognisable in rooms. 404 unless you are friends; 409 if " +
    "the conversation was closed.",
  security: bearerAuth,
  request: { params: z.object({ userId: z.string() }) },
  responses: {
    200: {
      description: "Conversation",
      content: { "application/json": { schema: wrap(z.object({ conversationId: z.string().uuid() })) } },
    },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "get",
  path: "/api/mobile/friends/invite",
  tags,
  summary: "My invite link",
  description: "Made on first ask and kept until reset.",
  security: bearerAuth,
  responses: {
    200: { description: "Invite link", content: { "application/json": { schema: wrap(InviteSchema) } } },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "post",
  path: "/api/mobile/friends/invite",
  tags,
  summary: "Reset my invite link",
  description: "A new link. The old one then answers exactly as a link that never existed. Friends already made stay.",
  security: bearerAuth,
  responses: {
    200: { description: "New invite link", content: { "application/json": { schema: wrap(InviteSchema) } } },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "get",
  path: "/api/mobile/friends/invite/{token}",
  tags,
  summary: "Open an invite link",
  description:
    PARTICIPATION_GATE +
    SAME_404 +
    "Shows the link owner's name and photo — handing the link out is their consent — and where you stand with them.",
  security: bearerAuth,
  request: { params: z.object({ token: z.string() }) },
  responses: {
    200: {
      description: "Invite",
      content: { "application/json": { schema: wrap(z.object({ person: PersonSchema, state: FriendStateSchema })) } },
    },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "get",
  path: "/api/mobile/friends/requests",
  tags,
  summary: "Friend requests, both ways",
  description:
    "`incoming` leaves out what you answered \"Not now\". `outgoing` never says whether the other person did: " +
    "a decline that reaches the asker is a rejection.",
  security: bearerAuth,
  responses: {
    200: {
      description: "Requests",
      content: {
        "application/json": {
          schema: wrap(z.object({ incoming: z.array(RequestItemSchema), outgoing: z.array(RequestItemSchema) })),
        },
      },
    },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "post",
  path: "/api/mobile/friends/requests",
  tags,
  summary: "Ask to be friends",
  description:
    PARTICIPATION_GATE +
    SAME_404 +
    "Exactly one of `token` (somebody's invite link) or `userId` (only for someone you can already see: a match, " +
    "a conversation, someone public in your room). Idempotent and cannot nag: asking again neither notifies again " +
    "nor un-dismisses. `friends` when they had already asked you. 400 for your own link.",
  security: bearerAuth,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.union([z.object({ token: z.string() }), z.object({ userId: z.string() })]),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Asked",
      content: { "application/json": { schema: wrap(z.object({ state: z.enum(["requested", "friends"]) })) } },
    },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "post",
  path: "/api/mobile/friends/requests/{requestId}",
  tags,
  summary: "Accept, or \"Not now\"",
  description:
    "Recipient only; anyone else gets the 404 a missing request gets. `dismiss` hides it from you and is never " +
    "reported to the sender.",
  security: bearerAuth,
  request: {
    params: z.object({ requestId: z.string().uuid() }),
    body: { content: { "application/json": { schema: z.object({ action: z.enum(["accept", "dismiss"]) }) } } },
  },
  responses: {
    200: {
      description: "Answered",
      content: {
        "application/json": {
          schema: wrap(z.union([z.object({ state: z.literal("friends") }), z.object({ dismissed: z.literal(true) })])),
        },
      },
    },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "delete",
  path: "/api/mobile/friends/requests/{requestId}",
  tags,
  summary: "Withdraw a request",
  description: "Sender only. Kept as withdrawn, so asking again later neither re-notifies nor undoes a \"Not now\".",
  security: bearerAuth,
  request: { params: z.object({ requestId: z.string().uuid() }) },
  responses: {
    200: { description: "Withdrawn", content: { "application/json": { schema: wrap(z.object({ withdrawn: z.literal(true) })) } } },
    ...standardErrors,
  },
})
