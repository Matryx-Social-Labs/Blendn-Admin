import { z } from "zod"
import { registry } from "@/lib/openapi/registry"
import { PaginationMetaSchema, PARTICIPATION_GATE, standardErrors, UserRefParamSchema } from "@/lib/openapi/schemas/common"
import {
  UserPublicProfileSchema,
  UserFavoritesResponseSchema,
  MessageRequestCreateSchema,
  MessageRequestRespondSchema,
  MessageRequestSchema,
  MessageRequestListResponseSchema,
  MessageRequestRespondResponseSchema,
  PresignedUrlRequestSchema,
  PresignedUrlResponseSchema,
  DeleteUploadRequestSchema,
  NotificationTokenRequestSchema,
  CategorySchema,
  ActiveCheckinSchema,
} from "@/lib/openapi/schemas/profile"
import { MessageResponseSchema } from "@/lib/openapi/schemas/auth"
import { CheckinRequestSchema } from "@/lib/openapi/schemas/event"

const bearerAuth = [{ BearerAuth: [] }]
const wrap = (schema: z.ZodTypeAny) => z.object({ success: z.literal(true), data: schema })

// === Categories ===

registry.registerPath({
  method: "get",
  path: "/api/mobile/categories",
  tags: ["Mobile Categories"],
  summary: "List all categories",
  description: "Returns hierarchical category tree with event and interest counts.",
  security: bearerAuth,
  responses: {
    // `data.categories`, matching every other list endpoint — see
    // app/api/mobile/categories/route.ts.
    200: {
      description: "Categories",
      content: {
        "application/json": {
          schema: wrap(z.object({ categories: z.array(CategorySchema) })),
        },
      },
    },
    ...standardErrors,
  },
})

// === Venues (Hotspots) ===

const VenueListItemSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    address: z.string().nullable(),
    city: z.string().nullable(),
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
    capacity: z.number().int().nullable(),
    venueType: z.string().nullable(),
    venueTypeLabel: z.string(),
    floors: z.number().int().min(1).max(200).nullable()
      .describe(
        "How many floors the venue's building has, set by its owner or an admin: the 3D map draws it " +
          "`floors × 3.66` m tall over the building data's own height. `null`: use the map's height."
      ),
    distance: z
      .number()
      .nullable()
      .describe("Kilometres from the supplied lat/lon, or null when either side has no fix."),
    upcomingEventCount: z.number().int(),
    liveNow: z
      .enum(["quiet", "5-9", "10-19", "20+"])
      .nullable()
      .describe(
        "How many guests are live here (Go Live), as a bucket and never a number: `quiet` is under 5, " +
          "none included. Steady for a minute per venue, slow to fall, and leaving the caller out only when " +
          "the figure counted them — the same figure as `live.liveNow` on `GET /api/mobile/venues/{venueId}`. " +
          "`null` for a caller the venue page would refuse (not onboarded, or no known adult age): hide the chip."
      ),
    nextEvent: z
      .object({
        id: z.string().uuid(),
        title: z.string(),
        slug: z.string().nullable(),
        coverImageUrl: z.string().nullable(),
        startTime: z.string().datetime(),
        endTime: z.string().datetime(),
      })
      .nullable()
      .describe(
        "The soonest public event this venue is hosting, age-filtered for the caller. " +
          "Supplies the card image — `venues` has no image column of its own. Null when " +
          "nothing is coming up, so no card claims something is happening when nothing is."
      ),
  })
  .openapi("VenueListItem")

registry.registerPath({
  method: "get",
  path: "/api/mobile/venues",
  tags: ["Mobile Venues"],
  summary: "List venues (the Hotspots feed)",
  description:
    "The venue-shaped twin of the events feed. Takes the same `city`, `lat`/`lon`, `radius` " +
    "and pagination vocabulary as `GET /api/mobile/events`, because one screen switches " +
    "between them.\n\n" +
    "Returns active, non-deleted venues only. Each item carries `upcomingEventCount` and its " +
    "`nextEvent`, both computed with the **same** filter — published, public, not yet ended, " +
    "not disputed by the venue, and within the caller's `min_age` where their age is known.\n\n" +
    "**A venue a real event has taken over is left out**: from an hour before a published, public " +
    "event at it starts until that event ends (per day of a multi-day run), when its link is confirmed " +
    "or its area is at the venue, and never for a disputed link, a venue's own Go Live day, or an event " +
    "the caller is too young for. The event's card on `GET /api/mobile/events` names the venue instead " +
    "(`venue`). Each item's `liveNow` is a bucket, never a count, or null for a caller who may not go live. " +
    "Ordered by name then id, so equal names keep one order across pages. 60 reads a minute per person.\n\n" +
    "`radius` has no default: sending coordinates means *sort by distance*, never *hide " +
    "anything further than N km*. `sortBy` offers `name` and `distance` only — ranking by " +
    "\"most going on\" would need a filtered relation count Prisma cannot order by.",
  security: bearerAuth,
  request: {
    query: z.object({
      page: z.coerce.number().int().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      search: z.string().max(200).optional(),
      city: z.string().min(1).max(100).optional(),
      lat: z.coerce.number().min(-90).max(90).optional(),
      lon: z.coerce.number().min(-180).max(180).optional(),
      radius: z.coerce.number().min(0.1).max(100).optional(),
      venueType: z.string().optional(),
      sortBy: z.enum(["name", "distance"]).optional(),
      sortOrder: z.enum(["asc", "desc"]).optional(),
    }),
  },
  responses: {
    200: {
      description: "Venues",
      content: {
        "application/json": {
          schema: wrap(
            z.object({
              venues: z.array(VenueListItemSchema),
              pagination: PaginationMetaSchema,
            })
          ),
        },
      },
    },
    ...standardErrors,
  },
})

const LiveCountBucketSchema = z
  .enum(["none", "a_few", "5-9", "10-19", "20+"])
  .describe(
    "How many are live here, never as a number (D-19): a count that moved from 4 to 5 as you watched " +
      "would tell you somebody just walked in. `a_few` is 1 to 4."
  )

const VenueDetailSchema = z
  .object({
    venue: z.object({
      id: z.string().uuid(),
      name: z.string(),
      address: z.string().nullable(),
      city: z.string().nullable(),
      latitude: z.number().nullable(),
      longitude: z.number().nullable(),
      venueType: z.string().nullable(),
      venueTypeLabel: z.string(),
      floors: z.number().int().min(1).max(200).nullable()
        .describe(
          "How many floors the venue's building has, set by its owner or an admin: the 3D map draws it " +
            "`floors × 3.66` m tall over the building data's own height. `null`: use the map's height."
        ),
      claimed: z.boolean().describe("False: the app may offer \"Own this place? Claim it\"."),
    }),
    live: z.object({
      open: z.boolean().describe("Whether `POST .../live` would be accepted here now (the fence aside)."),
      closedReason: z
        .enum(["event_live_here", "no_check_in_area"])
        .nullable()
        .describe("`event_live_here`: a real event has the venue — check in to `eventId` instead."),
      eventId: z.string().uuid().nullable(),
      liveNow: LiveCountBucketSchema,
      youAreLive: z.boolean(),
      expiresAt: z
        .string()
        .datetime()
        .nullable()
        .describe("When your window here ends. Count down from this, not from the tap."),
      stay: z.boolean(),
      venueDayId: z.string().uuid().nullable().describe("Today's room here, when you are live in it."),
      chatGroupId: z.string().uuid().nullable(),
    }),
    tonight: z
      .object({
        id: z.string().uuid(),
        title: z.string(),
        slug: z.string(),
        coverImageUrl: z.string().nullable(),
        startTime: z.string().datetime(),
        endTime: z.string().datetime(),
      })
      .nullable()
      .describe("The next public event here before the venue's day resets, age-filtered for you."),
  })
  .openapi("VenueDetail")

registry.registerPath({
  method: "get",
  path: "/api/mobile/venues/{venueId}",
  tags: ["Mobile Venues"],
  summary: "One venue, for Go Live",
  description:
    PARTICIPATION_GATE +
    "404 for an unknown, archived or deleted venue. Whether you could go live here now, how many " +
    "are live (a bucket), your own window, and tonight's event. Never the check-in area, and never " +
    "who is live: that is the venue day's roster, which only somebody live here may read.",
  security: bearerAuth,
  request: { params: z.object({ venueId: z.string().uuid() }) },
  responses: {
    200: { description: "The venue", content: { "application/json": { schema: wrap(VenueDetailSchema) } } },
    ...standardErrors,
  },
})

const GoLiveRequestSchema = z
  .union([
    CheckinRequestSchema.extend({ minutes: z.union([z.literal(20), z.literal(45), z.literal(60)]) }),
    CheckinRequestSchema.extend({ stay: z.literal(true) }),
  ])
  .openapi("GoLiveRequest")

const GoLiveResponseSchema = z
  .object({
    venueDayId: z.string().uuid().describe("Today's room at this venue: its roster, grid and presence pings use this id."),
    chatGroupId: z.string().uuid(),
    expiresAt: z.string().datetime().describe("When this window ends. Never past the venue's daily reset."),
    stay: z.boolean(),
    stayUntil: z
      .string()
      .datetime()
      .nullable()
      .describe("For `stay`: the furthest in-fence pings may carry `expiresAt` (four hours, or the reset)."),
    checkIn: z.object({ id: z.string().uuid(), status: z.string(), checkInTime: z.string().datetime() }),
    revealSuggestion: z.boolean(),
    intentNeeded: z.boolean(),
  })
  .openapi("GoLiveResponse")

const EventLiveHereSchema = z
  .object({
    success: z.literal(false),
    error: z.string(),
    errorCode: z.literal("EVENT_LIVE_HERE"),
    eventId: z.string().uuid().describe("The event to check in to instead."),
  })
  .openapi("EventLiveHere")

registry.registerPath({
  method: "post",
  path: "/api/mobile/venues/{venueId}/live",
  tags: ["Mobile Venues"],
  summary: "Go Live at a venue",
  description:
    "Be visible at this venue for a window you choose: `minutes` 20, 45 or 60, or `stay: true` " +
    "(60 minutes, then carried on by each presence ping inside the area, up to four hours). No window " +
    "runs past the venue's daily reset (06:00 local by default). Going live again while live extends " +
    "the window, never shortens it; going live elsewhere, or checking in to an event, ends it as a " +
    "switch. When it ends you are checked out (`expired`) and the venue's room closes to you.\n\n" +
    "Refusals, in order: 403 `PLUS_REQUIRED` for `stay` while Plus gating is on; 404 unknown, " +
    "archived or deleted venue; " +
    PARTICIPATION_GATE +
    "409 `EVENT_LIVE_HERE` with `eventId` when a public event linked to this venue is on or starts " +
    "within the hour — check in to it instead; 400 `OUT_OF_RANGE` for a fix worse than 150 m, a venue " +
    "with no check-in area, or a position outside it.",
  security: bearerAuth,
  request: {
    params: z.object({ venueId: z.string().uuid() }),
    body: { content: { "application/json": { schema: GoLiveRequestSchema } } },
  },
  responses: {
    200: { description: "Live", content: { "application/json": { schema: wrap(GoLiveResponseSchema) } } },
    409: { description: "A real event has the venue", content: { "application/json": { schema: EventLiveHereSchema } } },
    ...standardErrors,
  },
})

// === Work fields ===

registry.registerPath({
  method: "get",
  path: "/api/mobile/work-fields",
  tags: ["Mobile Categories"],
  summary: "List the coarse fields of work",
  description:
    "The eighteen buckets `profiles.work_field` accepts, as `{ slug, label }`. Served rather " +
    "than hardcoded in the client: a hardcoded copy cannot show a bucket added after the build " +
    "shipped, and free text is the mistake `profiles.interests` made — 'Software' and 'software " +
    "engineering' never match. Identical for every caller and safe to cache for an hour. " +
    "Also carries `expertiseByField` — the specialisms inside each bucket, keyed by the same " +
    "slugs — because the picker is one question in two steps and a client with only the first " +
    "would have to fetch between two taps of the same screen. `other` is present with an empty " +
    "array on purpose: a missing key and a knowingly empty one must not look the same.",
  security: bearerAuth,
  responses: {
    200: {
      description: "Work fields",
      content: {
        "application/json": {
          schema: wrap(
            z.object({
              workFields: z.array(z.object({ slug: z.string(), label: z.string() })),
              expertiseByField: z.record(
                z.string(),
                z.array(z.object({ slug: z.string(), label: z.string() }))
              ),
              maxExpertise: z.number().int(),
            })
          ),
        },
      },
    },
    ...standardErrors,
  },
})

// === Users ===

registry.registerPath({
  method: "get",
  path: "/api/mobile/users/{userId}",
  tags: ["Mobile Users"],
  summary: "Get user public profile",
  description:
    "What a room card opens. `userId` may be a room handle, and `id` echoes it as sent (SCRUM-371). A handle is answered in that room's terms — revealed there, or a friend with `friends_see_me_in_rooms` on — never from a reveal, like or conversation elsewhere. For somebody the room keeps anonymous only `id`, `name` (their pseudonym there), `age`, `location`, `isOwnProfile` and `identityVisible` come back. `connection` is present only when `identityVisible` is true.",
  security: bearerAuth,
  request: { params: z.object({ userId: UserRefParamSchema }) },
  responses: {
    200: { description: "User profile", content: { "application/json": { schema: wrap(UserPublicProfileSchema) } } },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "get",
  path: "/api/mobile/users/{userId}/favorites",
  tags: ["Mobile Users"],
  summary: "Get user's favorite events",
  security: bearerAuth,
  request: {
    params: z.object({ userId: z.string().uuid() }),
    query: z.object({
      page: z.number().optional(),
      limit: z.number().optional(),
      timeFilter: z.enum(["upcoming", "past"]).optional(),
      lat: z.number().optional(),
      lon: z.number().optional(),
    }),
  },
  responses: {
    200: { description: "Favorites", content: { "application/json": { schema: wrap(UserFavoritesResponseSchema) } } },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "post",
  path: "/api/mobile/users/{userId}/block",
  tags: ["Mobile Users"],
  summary: "Block user",
  security: bearerAuth,
  request: { params: z.object({ userId: UserRefParamSchema }) },
  responses: {
    200: { description: "Blocked", content: { "application/json": { schema: wrap(z.object({ blocked: z.literal(true) })) } } },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "delete",
  path: "/api/mobile/users/{userId}/block",
  tags: ["Mobile Users"],
  summary: "Unblock user",
  description:
    "`userId` is the `blocked_id` from `GET /users/blocked` (an opaque `bk_…` ref to one of your " +
    "blocks), a room handle, or — for older clients — a raw id. Only a block you made is removed; " +
    "anything else is a 200 that changes nothing.",
  security: bearerAuth,
  request: { params: z.object({ userId: UserRefParamSchema }) },
  responses: {
    200: { description: "Unblocked", content: { "application/json": { schema: wrap(z.object({ blocked: z.literal(false) })) } } },
    ...standardErrors,
  },
})

// === Message Requests ===

registry.registerPath({
  method: "post",
  path: "/api/mobile/message-requests",
  tags: ["Mobile Message Requests"],
  summary: "Send message request",
  description:
    PARTICIPATION_GATE +
    "Both of you must have attended the same event. 409 if a request is pending or accepted in either direction, if you already sent one that was declined — a rejection is not an invitation to try again — or if you already have a conversation; the person who declined may ask you. **Those 409s are said only when `identityVisible` would be true for the recipient** (SCRUM-371): to anyone else they answer 201 with this same shape and a fresh id, write nothing and notify nobody, so a room handle cannot be probed for a friend DM or an earlier request. `recipientId` may be a room handle and is echoed as sent. The response names the recipient by that ref only: their name and photo are what accepting discloses, not asking.",
  security: bearerAuth,
  request: {
    body: { content: { "application/json": { schema: MessageRequestCreateSchema } } },
  },
  responses: {
    201: { description: "Request sent", content: { "application/json": { schema: wrap(z.object({ request: MessageRequestSchema })) } } },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "get",
  path: "/api/mobile/message-requests",
  tags: ["Mobile Message Requests"],
  summary: "List received message requests",
  security: bearerAuth,
  request: {
    query: z.object({
      status: z.enum(["pending", "accepted", "declined", "blocked"]).optional(),
      limit: z.number().optional(),
      offset: z.number().optional(),
    }),
  },
  responses: {
    200: { description: "Requests", content: { "application/json": { schema: wrap(MessageRequestListResponseSchema) } } },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "post",
  path: "/api/mobile/message-requests/{requestId}/respond",
  tags: ["Mobile Message Requests"],
  summary: "Respond to message request",
  description:
    "Recipient only. A request that is not yours to answer is 404, the same as one that does not exist, so a sender cannot check which request ids are real (SCRUM-371).",
  security: bearerAuth,
  request: {
    params: z.object({ requestId: z.string().uuid() }),
    body: { content: { "application/json": { schema: MessageRequestRespondSchema } } },
  },
  responses: {
    200: { description: "Response recorded", content: { "application/json": { schema: wrap(MessageRequestRespondResponseSchema) } } },
    ...standardErrors,
  },
})

// === Uploads ===

registry.registerPath({
  method: "post",
  path: "/api/mobile/uploads/presigned-url",
  tags: ["Mobile Uploads"],
  summary: "Get presigned upload URL",
  description: "Returns a presigned URL for direct file upload to S3/Tigris. URL expires in 15 minutes.",
  security: bearerAuth,
  request: {
    body: { content: { "application/json": { schema: PresignedUrlRequestSchema } } },
  },
  responses: {
    200: { description: "Presigned URL", content: { "application/json": { schema: wrap(PresignedUrlResponseSchema) } } },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "delete",
  path: "/api/mobile/uploads/delete",
  tags: ["Mobile Uploads"],
  summary: "Delete uploaded file",
  security: bearerAuth,
  request: {
    body: { content: { "application/json": { schema: DeleteUploadRequestSchema } } },
  },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: wrap(z.object({ deleted: z.literal(true) })) } } },
    ...standardErrors,
  },
})

// === Notifications ===

registry.registerPath({
  method: "post",
  path: "/api/mobile/notifications/token",
  tags: ["Mobile Notifications"],
  summary: "Register push notification token",
  security: bearerAuth,
  request: {
    body: { content: { "application/json": { schema: NotificationTokenRequestSchema } } },
  },
  responses: {
    200: { description: "Token registered", content: { "application/json": { schema: wrap(MessageResponseSchema) } } },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "delete",
  path: "/api/mobile/notifications/token",
  tags: ["Mobile Notifications"],
  summary: "Unregister push notification token",
  security: bearerAuth,
  request: {
    query: z.object({ token: z.string() }),
  },
  responses: {
    200: { description: "Token removed", content: { "application/json": { schema: wrap(MessageResponseSchema) } } },
    ...standardErrors,
  },
})

/*
 * The notifications centre — the bell in The Pulse's top bar.
 *
 * Every row is written by `sendPushNotification`, *before* the token lookup, so
 * the feed holds what was sent rather than what was delivered. The three ways a
 * push does not arrive — notifications off, no device registered, expired token
 * — are all reasons to look at the bell, not reasons for it to be empty.
 *
 * Messages are not here: DMs and room messages live in their own inbox, and the
 * feed never returns `private_message`, `group_message` or `event_checkin`
 * (`NOT_IN_THE_BELL` in `lib/push-notifications.ts`).
 */
const NotificationSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum([
    "event_update",
    "announcement",
    "message_request",
    "message_request_response",
    "waitlist_promoted",
    "match",
    "reveal_request",
    "reveal",
    "board_request",
    "board_request_accepted",
    "friend_request",
    "friend_accepted",
    "rating_request",
    "crew_invite",
    "crew_here",
    "blend",
  ]),
  title: z.string(),
  body: z.string(),
  /** The same payload the push carried, so the app has one deep-link switch. */
  data: z.record(z.string(), z.unknown()).nullable(),
  readAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
})

registry.registerPath({
  method: "get",
  path: "/api/mobile/notifications",
  tags: ["Mobile Notifications"],
  summary: "List the caller's notifications, newest first",
  description:
    "Cursor-paginated because the list grows at the head — offset pages would repeat rows as new ones arrive. Returns only the caller's own; `user_id` comes from the token and is never a parameter. `unreadCount` ships with the feed so the bell needs one request rather than two.",
  security: bearerAuth,
  request: {
    query: z.object({
      cursor: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      unread: z.enum(["true", "false"]).optional(),
    }),
  },
  responses: {
    200: {
      description: "Notifications",
      content: {
        "application/json": {
          schema: wrap(
            z.object({
              notifications: z.array(NotificationSchema),
              unreadCount: z.number().int(),
              pagination: z.object({
                limit: z.number().int(),
                hasMore: z.boolean(),
                nextCursor: z.string().uuid().optional(),
              }),
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
  path: "/api/mobile/notifications",
  tags: ["Mobile Notifications"],
  summary: "Clear the caller's notifications",
  description:
    "Deletes rather than marks read — a 'clear all' that leaves every row in place is a lie the retention query trips over.",
  security: bearerAuth,
  responses: {
    200: {
      description: "Cleared",
      content: { "application/json": { schema: wrap(z.object({ deleted: z.number().int() })) } },
    },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "post",
  path: "/api/mobile/notifications/read",
  tags: ["Mobile Notifications"],
  summary: "Mark notifications read",
  description:
    "Omit `ids` to mark all of the caller's. The caller's `user_id` stays in the filter even when ids are named, so a uuid alone cannot reach somebody else's row. Already-read rows are skipped rather than re-stamped — `read_at` answers 'when did they see this', and a bell tapped twice must not move the answer.",
  security: bearerAuth,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ ids: z.array(z.string().uuid()).max(200).optional() }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Marked",
      content: {
        "application/json": {
          schema: wrap(z.object({ marked: z.number().int(), unreadCount: z.number().int() })),
        },
      },
    },
    ...standardErrors,
  },
})

/*
 * The amenity vocabulary — what an event can say it offers.
 *
 * Public, like `/categories`: a fixed vocabulary carrying nothing about any
 * person or event. Requiring a token would only mean the organiser's picker
 * cannot be drawn until after sign-in, for no gain.
 */
registry.registerPath({
  method: "get",
  path: "/api/mobile/amenities",
  tags: ["Mobile Events"],
  summary: "List the amenity vocabulary",
  description:
    "Active amenities only, in the vocabulary's own `sort_order` — alphabetical would put \"Accessible Entrance\" at the top of every picker and card. A retired amenity (`is_active = false`) still resolves on events that reference it; it simply stops being offered for new ones, because deleting one would rewrite what past events said they offered.",
  responses: {
    200: {
      description: "Amenities",
      content: {
        "application/json": {
          schema: wrap(
            z.object({
              amenities: z.array(
                z.object({
                  id: z.string().uuid(),
                  name: z.string(),
                  slug: z.string(),
                  subtitle: z.string().nullable(),
                  icon: z.string().nullable(),
                })
              ),
            })
          ),
        },
      },
    },
    ...standardErrors,
  },
})

// === Active Checkins ===

registry.registerPath({
  method: "get",
  path: "/api/mobile/checkins/active",
  tags: ["Mobile Checkins"],
  summary: "Get active check-ins",
  description: "Returns all events the user is currently checked into.",
  security: bearerAuth,
  responses: {
    200: { description: "Active check-ins", content: { "application/json": { schema: wrap(z.object({ checkIns: z.array(ActiveCheckinSchema) })) } } },
    ...standardErrors,
  },
})

/*
 * === Trust & safety, account, Apple sign-in ===
 *
 * These five endpoints shipped without spec entries — found by
 * __tests__/openapi-coverage.test.ts rather than by anyone noticing. Three of
 * them are the safety surface (report a message, report a user, list who you
 * have blocked), which is precisely the part a client developer must not have
 * to reverse-engineer from the source.
 */

registry.registerPath({
  method: "post",
  path: "/api/mobile/auth/apple",
  tags: ["Mobile Auth"],
  summary: "Sign in with Apple",
  description:
    "Exchanges an Apple identity token for Blend'n access and refresh tokens. `fullName` is only supplied by Apple on the very first authorisation, so persist it then — it is not sent again.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            identityToken: z.string().min(1),
            fullName: z
              .object({
                givenName: z.string().nullable().optional(),
                familyName: z.string().nullable().optional(),
              })
              .optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Authenticated",
      content: {
        "application/json": {
          schema: wrap(
            z.object({
              accessToken: z.string(),
              refreshToken: z.string(),
              user: z.object({
                id: z.string(),
                email: z.string(),
                name: z.string().nullable(),
              }),
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
  path: "/api/mobile/messages/{messageId}/report",
  tags: ["Mobile Safety"],
  summary: "Report a message",
  description:
    "Reports a group or private message. `messageType` is required because the two live in different tables and the id alone is ambiguous.",
  security: bearerAuth,
  request: {
    params: z.object({ messageId: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            messageType: z.enum(["group", "private"]),
            reason: z.string().min(1),
            description: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Report filed", content: { "application/json": { schema: wrap(MessageResponseSchema) } } },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "post",
  path: "/api/mobile/users/{userId}/report",
  tags: ["Mobile Safety"],
  summary: "Report a user",
  security: bearerAuth,
  request: {
    params: z.object({ userId: UserRefParamSchema }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            reason: z.string().min(1),
            description: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Report filed", content: { "application/json": { schema: wrap(MessageResponseSchema) } } },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "post",
  path: "/api/mobile/events/{eventId}/report",
  tags: ["Mobile Safety"],
  summary: "Report an event",
  description:
    "An unsafe venue, a misleading listing, a dangerous organiser. No check-in " +
    "required: two of those three are visible from the listing, and the value is " +
    "catching them before somebody travels to the venue.",
  security: bearerAuth,
  request: {
    params: z.object({ eventId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            reason: z.string().min(1),
            description: z.string().max(2000).optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Report filed",
      content: { "application/json": { schema: wrap(z.object({ reported: z.boolean() })) } },
    },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "get",
  path: "/api/mobile/users/blocked",
  tags: ["Mobile Safety"],
  summary: "List blocked users",
  description:
    "`blocked_id` is an opaque ref to the block (`bk_…`), not the person's account id: somebody " +
    "blocked by their board post or room handle was never shown an id, and this list must not be " +
    "where it arrives. Send it back to `DELETE /users/{userId}/block` to unblock. A name and photo " +
    "appear only where the identity rules allow.",
  security: bearerAuth,
  responses: {
    200: {
      description: "Blocked users",
      content: {
        "application/json": {
          schema: wrap(
            z.object({
              users: z.array(
                z.object({
                  /** An opaque ref to this block (`bk_…`), never an account id. */
                  blocked_id: z.string(),
                  blocked_user_name: z.string().nullable(),
                  blocked_user_photo: z.string().nullable(),
                  reason: z.string().nullable(),
                  blocked_at: z.string().datetime(),
                })
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
  method: "delete",
  path: "/api/mobile/account",
  tags: ["Mobile Profile"],
  summary: "Delete your own account",
  description:
    "Anonymises the account rather than hard-deleting the row. Events, chat messages and check-ins cascade from User, so a real delete would destroy other people's event history and conversations along with yours.",
  security: bearerAuth,
  responses: {
    200: { description: "Account deleted", content: { "application/json": { schema: wrap(MessageResponseSchema) } } },
    ...standardErrors,
  },
})
