import { z } from "zod"
import { registry } from "@/lib/openapi/registry"
import { ErrorResponseSchema, ListPaginationSchema, ListQuerySchema, PARTICIPATION_GATE, standardErrors, wrap, bearerAuth } from "@/lib/openapi/schemas/common"

/*
 * The Lobby (was the Board), SCRUM-1026. Routes keep their `/board` paths so
 * installed builds keep working; the screens call it the Lobby.
 */

const KIND = z.enum(["offer", "seeking", "chat"])
const SUB_KIND = z
  .enum(["ride", "spots", "ticket", "buddy"])
  .describe("What about: an offer of a `ride`, `spots` or a spare `ticket`; a search for a `ride`, somebody to go with (`buddy`) or a `ticket`. Null on `chat`, and on posts that did not say.")
const STATE = z
  .enum(["open", "read_only"])
  .describe("`open` until doors (90 minutes before the start, when check-in opens); `read_only` from doors until the room closes, a day after the end. A closed Lobby answers 403 `LOBBY_CLOSED` instead.")

const PHASE = z
  .enum(["before", "live"])
  .describe("`before` while the Lobby is the place (until doors); `live` once doors have opened and the room is. A live Lobby with no posts reads \"Nobody posted in the Lobby. The room is open.\" with \"Open the room\".")

const LIFECYCLE =
  "One lifecycle with the room and the posts' rooms: open (read, post, ask) until doors, read-only from doors " +
  "(read, answer asks, withdraw, report, block), and closed a day after the event ends, at the same moment as the room. " +
  "A closed Lobby answers 403 with `reasonCode` `LOBBY_CLOSED` (\"The Lobby has closed. The Lobby and the room close a day after the event ends.\"); " +
  "a write after doors 403 `LOBBY_READ_ONLY`. Not saved and not RSVP'd: 403 `BOARD_NOT_COMMITTED`. "

const PhotoSchema = z
  .object({
    status: z.enum(["pending", "approved", "rejected"]),
    url: z.string().nullable().describe("Signed, valid 15 minutes. Null for a rejected photo."),
    alt: z.string().nullable(),
  })
  .nullable()
  .describe(
    "One photo per post. Everybody gets an `approved` one. Only the author gets a `pending` one (\"Checking your photo\") or a `rejected` one (url null: \"Your photo wasn't posted.\"); " +
      "anybody else gets null until it is approved and never its URL. Location data is stripped by the server before it is stored."
  )
  .openapi("LobbyPhoto")

const PostSchema = z
  .object({
    id: z.string().uuid().describe("Deep-link friendly: `GET /events/{eventId}/board/{postId}` reads it alone."),
    eventId: z.string().uuid(),
    kind: KIND,
    subKind: SUB_KIND.nullable(),
    body: z.string(),
    spacesLeft: z.number().nullable().describe("Spots left on an offer (0 is Full); a spare ticket is 1 unless the author said otherwise; null elsewhere."),
    createdAt: z.string(),
    author: z.string().describe("The event's pseudonym, never a name."),
    mine: z.boolean(),
    requestCount: z.number(),
    photo: PhotoSchema,
  })
  .openapi("LobbyPost")

const HostPostSchema = z
  .object({
    id: z.string().uuid(),
    body: z.string(),
    host: z.string().describe("The host's public label (the organisation, or \"Organizer\"); never the person who wrote it."),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .nullable()
  .openapi("LobbyHostPost")

const CountsSchema = z
  .object({
    all: z.number().int(),
    offer: z.number().int(),
    seeking: z.number().int(),
    chat: z.number().int(),
    offerRides: z.number().int().describe("\"3 offering rides\"."),
    mine: z.number().int(),
    replies: z.number().int(),
  })
  .describe("Exact numbers; the compact form (1.2k) is the client's.")
  .openapi("LobbyCounts")

const SubKindsSchema = z
  .object({ offer: z.array(SUB_KIND), seeking: z.array(SUB_KIND), chat: z.array(SUB_KIND) })
  .describe("What the composer offers on this event: without `ticket` on an event whose tickets are sold on Blend'n.")

const eventParams = z.object({ eventId: z.string().uuid() })

registry.registerPath({
  method: "get",
  path: "/api/mobile/events/{eventId}/board",
  tags: ["Mobile Events"],
  summary: "The Lobby",
  description:
    PARTICIPATION_GATE +
    LIFECYCLE +
    "Going alone, and looking for somebody to go with. Readable by anyone who RSVP'd or saved the event. Authors are pseudonyms, the same handle the room uses; the " +
    "request count is a number and never a list. Posts by anybody blocked either way, or a friend, are left out, and so are ticket posts on an event whose tickets are sold on Blend'n. " +
    "Filters run on the server: `kind`, `subKind`, and `filter=mine` (your posts) or `filter=replies` (your posts somebody asked on, and the posts whose author said yes to you). " +
    "The first page (no `cursor`) also carries `counts` for the filter chips, the host's `pinned` post, and `compose` (whether you can post now, and if not the sentence and `reasonCode` for the composer's slot).",
  security: bearerAuth,
  request: {
    params: eventParams,
    query: ListQuerySchema.extend({ kind: KIND.optional(), subKind: SUB_KIND.optional(), filter: z.enum(["mine", "replies"]).optional() }),
  },
  responses: {
    200: {
      description: "Live posts, newest first, a page at a time (`?limit=` default 100, at most 100; `?cursor=`)",
      content: {
        "application/json": {
          schema: wrap(
            z.object({
              state: STATE,
              phase: PHASE,
              doorsAt: z.string(),
              closesAt: z.string(),
              ticketsHidden: z.boolean(),
              subKinds: SubKindsSchema,
              counts: CountsSchema.optional().describe("First page only."),
              pinned: HostPostSchema.optional().describe("First page only."),
              compose: z
                .object({ allowed: z.boolean(), message: z.string().nullable(), reasonCode: z.string().nullable() })
                .optional()
                .describe("First page only. `reasonCode`: `BOARD_NOT_GOING` (\"Say you're going to post\"), `BOARD_PROFILE_INCOMPLETE`, `BOARD_TOO_MANY_OUTSTANDING`, `BOARD_WEEKLY_LIMIT`, `LOBBY_READ_ONLY`."),
              you: z
                .object({ pseudonym: z.string().nullable() })
                .optional()
                .describe("First page only. Your own room name at this event, the handle your posts go up under (the composer's \"Posting as\"). Never anybody else's."),
              posts: z.array(PostSchema),
              pagination: ListPaginationSchema,
              takenDown: z
                .array(z.object({ id: z.string(), kind: KIND, body: z.string(), createdAt: z.string(), takenDownAt: z.string() }))
                .describe("YOUR posts a moderator or the automatic check took down, newest first, at most 20 (SV9), on the first page; [] after it."),
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
  path: "/api/mobile/events/{eventId}/board",
  tags: ["Mobile Events"],
  summary: "Post to the Lobby",
  description:
    PARTICIPATION_GATE +
    "Requires RSVP 'going', a complete profile, and room under both request caps; until doors (then 403 `LOBBY_READ_ONLY`). The text gets the room's checks before it is " +
    "stored (keywords, contact details, OpenAI): a hit is a 422 and nothing is stored. A `ticket` sub-kind on an event whose tickets are sold on Blend'n is 422 `LOBBY_TICKETS_HIDDEN`. " +
    "A photo is the upload's `publicUrl` from `POST /uploads/presigned-url` with `folder: \"chat\"` (JPEG, PNG or WebP, at most 10 MB): the server stores its own copy with " +
    "the location stripped, and it is `pending` (only you see it) until moderation approves it. Somebody else's file, or any other URL, is 400. " +
    "An offer with a sub-kind tells the people looking for that, who turned the alert on.",
  security: bearerAuth,
  request: {
    params: eventParams,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            kind: KIND,
            subKind: SUB_KIND.optional(),
            body: z.string().min(1).max(500),
            spacesLeft: z.number().int().min(0).max(20).optional(),
            photo: z.object({ url: z.string().url(), alt: z.string().max(200).optional() }).optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: { description: "Posted, as its author reads it", content: { "application/json": { schema: wrap(PostSchema) } } },
    ...standardErrors,
    422: { description: "Refused by moderation, a photo that did not finish uploading, or a hidden ticket; nothing stored", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
})

registry.registerPath({
  method: "get",
  path: "/api/mobile/events/{eventId}/board/{postId}",
  tags: ["Mobile Events"],
  summary: "One Lobby post (a post link)",
  description: LIFECYCLE + "The Lobby's own gate and read. A post that is gone, or by somebody hidden from you, is the same 404 as one that never existed.",
  security: bearerAuth,
  request: { params: z.object({ eventId: z.string().uuid(), postId: z.string().uuid() }) },
  responses: {
    200: { description: "The post", content: { "application/json": { schema: wrap(z.object({ state: STATE, phase: PHASE, closesAt: z.string(), post: PostSchema })) } } },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "get",
  path: "/api/mobile/events/{eventId}/board/preview",
  tags: ["Mobile Events"],
  summary: "The event page's Lobby card",
  description:
    LIFECYCLE.replace("Not saved and not RSVP'd: 403 `BOARD_NOT_COMMITTED`. ", "") +
    "Counts and the latest two posts in one call. Not saved and not RSVP'd: 200 with `canRead: false`, the counts, and `latest: []` (\"Save it or say you're going to read the Lobby.\").",
  security: bearerAuth,
  request: { params: eventParams },
  responses: {
    200: {
      description: "The preview",
      content: {
        "application/json": {
          schema: wrap(
            z.object({
              state: STATE,
              phase: PHASE,
              canRead: z.boolean(),
              doorsAt: z.string(),
              closesAt: z.string(),
              counts: CountsSchema.omit({ mine: true, replies: true }),
              latest: z.array(PostSchema).max(2),
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
  path: "/api/mobile/events/{eventId}/board/summary",
  tags: ["Mobile Events"],
  summary: "\"From the Lobby\", for the room",
  description:
    LIFECYCLE.replace("Not saved and not RSVP'd: 403 `BOARD_NOT_COMMITTED`. ", "Neither saved, RSVP'd nor checked in: 403 `BOARD_NOT_COMMITTED`. ") +
    "The rides and groups you are in through the Lobby (an ask of yours accepted, or one you accepted), each with its room when it has one and you are in it; how many asks are still waiting either way; the host's pinned post; and until when the Lobby can be read. " +
    "Nothing to show is `hasContent: false` with no card fields at all: the room shows no card. A host note alone is content (the card is just the note).",
  security: bearerAuth,
  request: { params: eventParams },
  responses: {
    200: {
      description: "The card",
      content: {
        "application/json": {
          schema: wrap(
            z.object({
              state: STATE,
              phase: PHASE,
              readUntil: z.string(),
              hasContent: z.boolean(),
              pinned: HostPostSchema.optional().describe("Only with `hasContent: true`."),
              joined: z.array(
                z.object({
                  postId: z.string().uuid(),
                  kind: KIND,
                  subKind: SUB_KIND.nullable(),
                  body: z.string(),
                  mine: z.boolean().describe("Your post, which others joined."),
                  author: z.string(),
                  others: z.number().int().describe("How many others are in it with you."),
                  chatGroupId: z.string().uuid().nullable().describe("The post's room (`/chat/groups/{id}`), once it has one and you are seated in it."),
                  requestId: z.string().uuid().nullable().describe("Your accepted ask on it."),
                  conversationId: z.string().uuid().nullable().describe("The 1:1 conversation your accepted ask opened (`/conversations/{id}`), while it exists; null on your own post and on a group room."),
                })
              ).optional(),
              asks: z.object({ yours: z.number().int(), waitingOnYou: z.number().int() }).optional(),
            })
          ),
        },
      },
    },
    ...standardErrors,
  },
})

const AlertsSchema = z
  .object({
    offersMatch: z.boolean().describe("Someone offers what you're looking for (push `board_match`)."),
    replies: z.boolean().describe("Stored and returned for installed builds; gates nothing since 2026-11-06. An ask on your post and a yes to yours (`board_request`, `board_request_accepted`) are always pushed, under the account's `matches` preference alone."),
    hostPosts: z.boolean().describe("The host's pinned post goes up or changes (push `board_host_post`)."),
  })
  .openapi("LobbyAlerts")

registry.registerPath({
  method: "get",
  path: "/api/mobile/events/{eventId}/board/alerts",
  tags: ["Mobile Events"],
  summary: "Your Lobby alerts for this event",
  description: LIFECYCLE + "The discovery alerts, off until you turn one on, for this event only: `offersMatch` and `hostPosts` (`replies` is kept for installed builds and gates nothing; asks and yeses are always pushed). Pushes say \"Lobby\" as the title and the event as the subtitle (iOS), and open the post.",
  security: bearerAuth,
  request: { params: eventParams },
  responses: { 200: { description: "The switches", content: { "application/json": { schema: wrap(AlertsSchema) } } }, ...standardErrors },
})

registry.registerPath({
  method: "put",
  path: "/api/mobile/events/{eventId}/board/alerts",
  tags: ["Mobile Events"],
  summary: "Set your Lobby alerts for this event",
  description: LIFECYCLE + "Any of the three; the ones left out keep their value. An unknown key is 400.",
  security: bearerAuth,
  request: { params: eventParams, body: { content: { "application/json": { schema: AlertsSchema.partial() } } } },
  responses: { 200: { description: "The switches now", content: { "application/json": { schema: wrap(AlertsSchema) } } }, ...standardErrors },
})
