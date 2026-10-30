import { z } from "zod"
import { registry } from "@/lib/openapi/registry"
import { BadgeSchema, ListPaginationSchema, ListQuerySchema, PARTICIPATION_GATE, standardErrors, UserRefParamSchema, wrap, bearerAuth } from "@/lib/openapi/schemas/common"

/*
 * Friends. Two rules shape every route here (see lib/friends.ts):
 * nobody can be looked up — every refusal a stranger can reach is the same
 * 404 — and friends are still pseudonyms in a room unless they turn on
 * `friends_see_me_in_rooms`.
 */

const tags = ["Mobile Friends"]

/** The invite landing's reasons, beside the errorCodes installed builds match on (SV10). */
const REASONS =
  "A refusal for an unfinished profile is 403 `FORBIDDEN` with `reasonCode` `PROFILE_INCOMPLETE`; a rate limit is 429 `RATE_LIMITED` " +
  "with `reasonCode` `RATE_LIMITED`, `retryAfter` (seconds, also the `Retry-After` header). The `errorCode`s are unchanged: read `reasonCode ?? errorCode`. "

const SAME_404 =
  "Every refusal a stranger could reach — unknown, malformed or reset token, deleted account, a block either way, " +
  "a pair who left each other, a user id you have no relationship with — answers with the same 404, so nothing here " +
  "tells anyone whether a person uses the app. The same body carries `reasonCode` — `PERSON_UNAVAILABLE` (asking by `userId`), " +
  "`INVITE_UNAVAILABLE` (a link) or `REQUEST_UNAVAILABLE` (answering a request) — which names what was asked for, never why it is out of reach. " +
  "`errorCode` stays `NOT_FOUND`. "

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
  description:
    "`?q=` (1-40 characters, trimmed) keeps the friends a word of whose name starts with it, case-insensitively: the rule of `GET /events/{eventId}/friends-here`'s `q`; " +
    "`count` and `pagination.totalCount` are then the filtered total, and it combines with `limit` and `cursor`. A longer `q` is 400. " +
    "Newest first, a page at a time (`?limit=`, `?cursor=`: without `limit` or `cursor` up to 200, otherwise default 100, 1-100), with the count the Me tab shows: " +
    "`count` and `pagination.totalCount` are the whole list, not the page. Real names and photos: both people said yes. " +
    "A blocked person is left out of the query, so a page is full.",
  security: bearerAuth,
  request: { query: ListQuerySchema.extend({ q: z.string().max(40).optional().describe("A word-prefix search of the friends' names. 1-40 characters.") }) },
  responses: {
    200: {
      description: "Friends",
      content: {
        "application/json": {
          schema: wrap(
            z.object({
              friends: z.array(PersonSchema.extend({ since: z.string() })),
              count: z.number().int(),
              pagination: ListPaginationSchema,
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
    "`conversationId` is an open DM, if there is one; null while it is still a pseudonymous one (a match or board DM not revealed on both sides). " +
    "A room handle resolves here only for a friend you can already recognise in that room (`friends_see_me_in_rooms` on); " +
    "any other handle is the same 404 as a stranger, so the route cannot say which card on a roster is a friend (SCRUM-371).",
  security: bearerAuth,
  request: { params: z.object({ userId: UserRefParamSchema }) },
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
              sharedInterests: z.array(z.string()).describe("The names, out of `interests`, that you hold too (SCRUM-896), exactly as `GET /users/{userId}` sends them, so one person is outlined the same from both doors. Additive."),
              work_field: z.string().nullable().describe("The about line, as `GET /users/{userId}` sends it to somebody who may see who this is. Additive."),
              expertise: z.array(z.string()).describe("Labels. Additive."),
              languages: z.array(z.string()).describe("Labels. Additive."),
              homeState: z.string().nullable().describe("A label. Additive."),
              sign: z.string().nullable().describe("A label, \"Leo ♌\". Additive."),
              badges: z
                .array(BadgeSchema)
                .optional()
                .describe("What check-ins earned, as the profile sends them: present (possibly empty) unless the friend turned `show_badges` off; absent then. Additive."),
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
  description:
    "Silent — nobody is told — and any DM is left alone. Idempotent. A room handle counts only for a friend you can recognise in that room, as on `GET`.",
  security: bearerAuth,
  request: { params: z.object({ userId: UserRefParamSchema }) },
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
    "the conversation was closed, or is still a pseudonymous DM not revealed on both sides (the same 409). A room handle counts only for a friend you can recognise in that room, as on `GET /friends/{userId}`.",
  security: bearerAuth,
  request: { params: z.object({ userId: UserRefParamSchema }) },
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
    REASONS +
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
  path: "/api/mobile/friends/invite/{token}/preview",
  tags,
  summary: "Preview an invite link, signed out",
  description:
    "**No authentication** — for the invite screen before sign-up. Rate-limited per IP (20 a minute). Returns only the owner's FIRST name and one photo: " +
    "not the full name, not a user id, not a friend state — the link may have been forwarded. " +
    "404 `NOT_FOUND` (the same one as `GET /friends/invite/{token}`) for a malformed, unknown or reset token, or a deleted or suspended owner. " +
    "Send a bearer token if you have one and the block rule applies too: a block either way, or a pair who left each other, is the same 404.",
  security: [],
  request: { params: z.object({ token: z.string() }) },
  responses: {
    200: {
      description: "Who sent the link",
      content: {
        "application/json": { schema: wrap(z.object({ name: z.string(), photoUrl: z.string().nullable() })) },
      },
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
    "a decline that reaches the asker is a rejection. Newest first, `?limit=` of each (without `limit` or `cursor`: up to 200; otherwise default 50, 1-100), " +
    "with `pagination.incoming` and `pagination.outgoing`. To page one list, ask for it alone: " +
    "`?list=incoming&cursor=…` answers only that array (a cursor without `list` is 400).",
  security: bearerAuth,
  request: { query: ListQuerySchema.extend({ list: z.enum(["incoming", "outgoing"]).optional() }) },
  responses: {
    200: {
      description: "Requests",
      content: {
        "application/json": {
          schema: wrap(
            z.object({
              incoming: z.array(RequestItemSchema).optional().describe("Absent when `?list=outgoing`."),
              outgoing: z.array(RequestItemSchema).optional().describe("Absent when `?list=incoming`."),
              pagination: z.object({ incoming: ListPaginationSchema.optional(), outgoing: ListPaginationSchema.optional() }),
            })
          ),
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
    REASONS +
    SAME_404 +
    "Exactly one of `token` (somebody's invite link) or `userId` (only for a match where you have BOTH revealed: an " +
    "open conversation that came from a mutual like, neither side closed or blocked. A room handle resolves too, but " +
    "a handle its room keeps anonymous is refused as unknown). Idempotent and cannot nag: asking again neither notifies again " +
    "nor un-dismisses. `friends` when they had already asked you. Between two people still pseudonyms to each other (an open match or board DM not revealed on both sides) the request is HELD: still `requested`, but no push, not in the recipient's list, not acceptable, until both reveal, when it is released and delivered.  400 for yourself, `reasonCode` `CANNOT_ADD_SELF`. " +
    "A request made by `userId` notifies with `data.via` = `match`, never an event or room. " +
    "One 404 differs: it carries `reasonCode` `NOT_A_REVEALED_MATCH` when you are in an open match with that person, " +
    "they have already revealed to you, and you have not revealed back (you know who they are). While they are still a " +
    "pseudonym to you, and for every other refusal, the 404 is byte-identical to an unknown id (`reasonCode` `PERSON_UNAVAILABLE`).",
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
