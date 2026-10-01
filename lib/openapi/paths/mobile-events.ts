import { z } from "zod"
import { registry } from "@/lib/openapi/registry"
import { ErrorResponseSchema, PARTICIPATION_GATE, standardErrors } from "@/lib/openapi/schemas/common"
import {
  EventQuerySchema,
  CheckinRequestSchema,
  RatingRequestSchema,
  RsvpRequestSchema,
  AnnounceRequestSchema,
  BatchEventIdsSchema,
  EventSearchQuerySchema,
  EventCitiesResponseSchema,
  CityDemandRequestSchema,
  EventListResponseSchema,
  EventDetailSchema,
  CheckinResponseSchema,
  CheckoutResponseSchema,
  RsvpResponseSchema,
  InterestResponseSchema,
  FavoriteResponseSchema,
  RatingResponseSchema,
  BatchCheckinsResponseSchema,
  BatchInterestsResponseSchema,
  BatchInterestCountsResponseSchema,
  AttendeeListResponseSchema,
  LikeRequestSchema,
  LikeResponseSchema,
  RoomPreviewResponseSchema,
  WaveRequestSchema,
  WaveResponseSchema,
  MatchListResponseSchema,
  PeerRatingRequestSchema,
  RatablePeersResponseSchema,
  MatchPreferencesSchema,
  InterestedUsersResponseSchema,
  EventSummarySchema,
} from "@/lib/openapi/schemas/event"
import { EventChatResponseSchema, SendMessageRequestSchema, ChatMessageSchema } from "@/lib/openapi/schemas/chat"

const bearerAuth = [{ BearerAuth: [] }]
const wrap = (schema: z.ZodTypeAny) => z.object({ success: z.literal(true), data: schema })

// GET /api/mobile/events
registry.registerPath({
  method: "get",
  path: "/api/mobile/events/{eventId}/board",
  tags: ["Mobile Events"],
  summary: "The pre-event board",
  description:
    PARTICIPATION_GATE +
    "Going alone, and looking for somebody to go with. Readable by anyone who " +
    "RSVP'd or favourited — somebody deciding whether to go is exactly who it is " +
    "for. Authors are pseudonyms, the same handle the room uses; the request " +
    "count is a number and never a list of who asked. An age-restricted event's " +
    "board answers 403 `AGE_RESTRICTED` for an under-age or unknown age, before " +
    "the RSVP/favourite gate. Closed once the doors open (`start_time`): 403 " +
    "\"The board closes when the doors open — the room is open instead\". Posts " +
    "by anybody blocked either way are left out.",
  security: bearerAuth,
  request: { params: z.object({ eventId: z.string() }) },
  responses: {
    200: {
      description: "Live posts, newest first",
      content: {
        "application/json": {
          schema: wrap(
            z.object({
              posts: z.array(
                z.object({
                  id: z.string(),
                  kind: z.enum(["offer", "seeking", "chat"]),
                  body: z.string(),
                  spacesLeft: z.number().nullable(),
                  createdAt: z.string(),
                  author: z.string(),
                  mine: z.boolean(),
                  requestCount: z.number(),
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
  method: "post",
  path: "/api/mobile/events/{eventId}/board",
  tags: ["Mobile Events"],
  summary: "Post to the board",
  description:
    PARTICIPATION_GATE +
    "Requires RSVP 'going' (not merely committed — offering a seat in a car you " +
    "may not be driving to is worse than not offering), a complete profile, and " +
    "room under both request caps. Closes when the doors open: after that the " +
    "room is the place, and it is gated on presence rather than intent. The " +
    "text gets the room's checks before it is stored (keywords, contact " +
    "details, OpenAI); a hit is a 422 and nothing is stored — contact details " +
    "say so, anything else reads \"This can't go on the board.\"",
  security: bearerAuth,
  request: {
    params: z.object({ eventId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            kind: z.enum(["offer", "seeking", "chat"]),
            body: z.string().min(1).max(500),
            spacesLeft: z.number().int().min(0).max(20).optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Posted",
      content: {
        "application/json": {
          schema: wrap(
            z.object({
              id: z.string(),
              kind: z.string(),
              body: z.string(),
              spacesLeft: z.number().nullable(),
              createdAt: z.string(),
            })
          ),
        },
      },
    },
    ...standardErrors,
    422: {
      description: "Refused by moderation; nothing stored",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
})

registry.registerPath({
  method: "delete",
  path: "/api/mobile/events/{eventId}/board/{postId}",
  tags: ["Mobile Events"],
  summary: "Withdraw your own board post",
  description:
    "Soft — the post leaves every board read, and requests filed against it " +
    "stop counting toward their senders' caps. Somebody else's post, or one " +
    "already withdrawn, is a 404.",
  security: bearerAuth,
  request: {
    params: z.object({ eventId: z.string(), postId: z.string() }),
  },
  responses: {
    200: {
      description: "Withdrawn",
      content: {
        "application/json": {
          schema: wrap(z.object({ id: z.string(), withdrawn: z.literal(true) })),
        },
      },
    },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "get",
  path: "/api/mobile/events",
  tags: ["Mobile Events"],
  summary: "List events",
  description: "Paginated event list with optional location, category, date, and status filters.",
  security: bearerAuth,
  request: { query: EventQuerySchema },
  responses: {
    200: {
      description: "Event list",
      content: { "application/json": { schema: wrap(EventListResponseSchema) } },
    },
    ...standardErrors,
  },
})

// POST /api/mobile/events/demand
registry.registerPath({
  method: "post",
  path: "/api/mobile/events/demand",
  tags: ["Mobile Events"],
  summary: "Record that a user is somewhere with no events",
  description:
    "Fire-and-forget. Call this when the device's city is not in GET /events/cities — the user is standing somewhere we have not launched, which is the only demand data the product gets before it has supply. One row per person per city: reopening the app is not a new signal, so send it at most once per session and never rely on the response.",
  security: bearerAuth,
  request: {
    body: { content: { "application/json": { schema: CityDemandRequestSchema } } },
  },
  responses: {
    200: {
      description: "Recorded",
      content: { "application/json": { schema: wrap(z.object({ recorded: z.boolean() })) } },
    },
    ...standardErrors,
  },
})

// GET /api/mobile/events/cities
registry.registerPath({
  method: "get",
  path: "/api/mobile/events/cities",
  tags: ["Mobile Events"],
  summary: "Cities you can browse",
  description:
    "The cities that currently have events, busiest first, with counts. Feeds the city picker: the client shows this immediately rather than reverse-geocoding on first launch, so a cold install with no location still has somewhere to browse. A city listed with N events opens with N events — the counts apply the same visibility and age rules as GET /api/mobile/events.",
  security: bearerAuth,
  responses: {
    200: {
      description: "Cities with event counts",
      content: { "application/json": { schema: wrap(EventCitiesResponseSchema) } },
    },
    ...standardErrors,
  },
})

// GET /api/mobile/events/search
registry.registerPath({
  method: "get",
  path: "/api/mobile/events/search",
  tags: ["Mobile Events"],
  summary: "Full-text search events",
  security: bearerAuth,
  request: { query: EventSearchQuerySchema },
  responses: {
    200: {
      description: "Search results",
      content: {
        "application/json": {
          schema: wrap(z.object({
            events: z.array(EventSummarySchema),
            pagination: z.object({
              page: z.number(),
              limit: z.number(),
              totalCount: z.number(),
              totalPages: z.number(),
              hasMore: z.boolean(),
            }),
          })),
        },
      },
    },
    ...standardErrors,
  },
})

// GET /api/mobile/events/{eventId}
registry.registerPath({
  method: "get",
  path: "/api/mobile/events/{eventId}",
  tags: ["Mobile Events"],
  summary: "Get event details",
  description:
    "Drafts and private events you are not on the list for answer 404. An 18+ event answers " +
    "403 `AGE_RESTRICTED` for a viewer below the line (see lib/event-access.ts).",
  security: bearerAuth,
  request: {
    params: z.object({ eventId: z.string().uuid() }),
    query: z.object({
      lat: z.number().optional(),
      lon: z.number().optional(),
      include: z.string().optional(),
      interestedLimit: z.number().optional(),
    }),
  },
  responses: {
    200: {
      description: "Event detail",
      content: { "application/json": { schema: wrap(EventDetailSchema) } },
    },
    ...standardErrors,
  },
})

// PATCH /api/mobile/events/{eventId}
registry.registerPath({
  method: "patch",
  path: "/api/mobile/events/{eventId}",
  tags: ["Mobile Events"],
  summary: "Update event (organizer only)",
  security: bearerAuth,
  request: {
    params: z.object({ eventId: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            title: z.string().optional(),
            description: z.string().optional(),
            shortDescription: z.string().optional(),
            status: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Updated event",
      content: { "application/json": { schema: wrap(z.object({ id: z.string(), title: z.string(), description: z.string().nullable(), shortDescription: z.string().nullable(), status: z.string() })) } },
    },
    ...standardErrors,
  },
})

// DELETE /api/mobile/events/{eventId}
registry.registerPath({
  method: "delete",
  path: "/api/mobile/events/{eventId}",
  tags: ["Mobile Events"],
  summary: "Delete event (organizer only)",
  security: bearerAuth,
  request: { params: z.object({ eventId: z.string().uuid() }) },
  responses: {
    200: { description: "Deleted", content: { "application/json": { schema: z.object({ success: z.literal(true) }) } } },
    ...standardErrors,
  },
})

// POST /api/mobile/events/{eventId}/checkin
registry.registerPath({
  method: "post",
  path: "/api/mobile/events/{eventId}/checkin",
  tags: ["Mobile Events"],
  summary: "Check in to event",
  description: PARTICIPATION_GATE + "GPS-verified check-in. Must be within event's check-in radius. Max GPS accuracy: 150m.",
  security: bearerAuth,
  request: {
    params: z.object({ eventId: z.string().uuid() }),
    body: { content: { "application/json": { schema: CheckinRequestSchema } } },
  },
  responses: {
    200: { description: "Checked in", content: { "application/json": { schema: wrap(CheckinResponseSchema) } } },
    ...standardErrors,
  },
})

// POST /api/mobile/events/{eventId}/checkout
registry.registerPath({
  method: "post",
  path: "/api/mobile/events/{eventId}/checkout",
  tags: ["Mobile Events"],
  summary: "Check out of event",
  security: bearerAuth,
  request: { params: z.object({ eventId: z.string().uuid() }) },
  responses: {
    200: { description: "Checked out", content: { "application/json": { schema: wrap(CheckoutResponseSchema) } } },
    ...standardErrors,
  },
})

// POST /api/mobile/events/{eventId}/presence
registry.registerPath({
  method: "post",
  path: "/api/mobile/events/{eventId}/presence",
  tags: ["Mobile Events"],
  summary: "Report location while checked in",
  description:
    "Called every few minutes while checked in, so the live count reflects who is " +
    "actually in the room. Judged with the same accuracy allowance as check-in, so " +
    "GPS drift indoors does not read as leaving. A first reading outside starts a " +
    "grace period; once it expires the response asks the attendee to confirm; if " +
    "nothing comes back they are checked out. Silence alone never checks anyone out " +
    "— a basement with no signal is not an empty room. Staff are never checked out " +
    "automatically.",
  security: bearerAuth,
  request: {
    params: z.object({ eventId: z.string().uuid() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            latitude: z.number(),
            longitude: z.number(),
            accuracy: z.number().nullable().optional().openapi({
              description: "Metres, as the device reports it. Omit if unknown.",
            }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Presence recorded",
      content: {
        "application/json": {
          schema: wrap(
            z.object({
              status: z.enum(["inside", "outside", "prompt", "checked_out", "not_checked_in"]),
              reason: z.string().optional(),
              shortfallMetres: z.number().nullable().optional(),
              graceEndsAt: z.string().nullable().optional(),
              nextPingInSeconds: z.number().optional(),
            })
          ),
        },
      },
    },
    ...standardErrors,
  },
})

// POST /api/mobile/events/{eventId}/rsvp
registry.registerPath({
  method: "post",
  path: "/api/mobile/events/{eventId}/rsvp",
  tags: ["Mobile Events"],
  summary: "RSVP to event",
  description:
    PARTICIPATION_GATE +
    "403 `AGE_RESTRICTED` on an age-restricted event for an under-age or unknown age; 404 for a draft " +
    "or a private event you are not on the list for (lib/event-access.ts).",
  security: bearerAuth,
  request: {
    params: z.object({ eventId: z.string().uuid() }),
    body: { content: { "application/json": { schema: RsvpRequestSchema } } },
  },
  responses: {
    200: { description: "RSVP recorded", content: { "application/json": { schema: wrap(RsvpResponseSchema) } } },
    ...standardErrors,
  },
})

// DELETE /api/mobile/events/{eventId}/rsvp
registry.registerPath({
  method: "delete",
  path: "/api/mobile/events/{eventId}/rsvp",
  tags: ["Mobile Events"],
  summary: "Cancel RSVP",
  security: bearerAuth,
  request: { params: z.object({ eventId: z.string().uuid() }) },
  responses: {
    200: { description: "RSVP cancelled", content: { "application/json": { schema: wrap(RsvpResponseSchema) } } },
    ...standardErrors,
  },
})

// POST /api/mobile/events/{eventId}/interest
registry.registerPath({
  method: "post",
  path: "/api/mobile/events/{eventId}/interest",
  tags: ["Mobile Events"],
  summary: "Toggle interest in event",
  security: bearerAuth,
  request: { params: z.object({ eventId: z.string().uuid() }) },
  responses: {
    200: { description: "Interest toggled", content: { "application/json": { schema: wrap(InterestResponseSchema) } } },
    ...standardErrors,
  },
})

// GET /api/mobile/events/{eventId}/interest
registry.registerPath({
  method: "get",
  path: "/api/mobile/events/{eventId}/interest",
  tags: ["Mobile Events"],
  summary: "Get interest status",
  security: bearerAuth,
  request: { params: z.object({ eventId: z.string().uuid() }) },
  responses: {
    200: { description: "Interest status", content: { "application/json": { schema: wrap(InterestResponseSchema) } } },
    ...standardErrors,
  },
})

// POST /api/mobile/events/{eventId}/favorite
registry.registerPath({
  method: "post",
  path: "/api/mobile/events/{eventId}/favorite",
  tags: ["Mobile Events"],
  summary: "Favorite event",
  description:
    PARTICIPATION_GATE +
    "Same answers as RSVP: 403 `AGE_RESTRICTED` on an age-restricted event for an under-age or " +
    "unknown age; 404 for a draft or a private event you are not on the list for.",
  security: bearerAuth,
  request: { params: z.object({ eventId: z.string().uuid() }) },
  responses: {
    200: { description: "Favorited", content: { "application/json": { schema: wrap(FavoriteResponseSchema) } } },
    ...standardErrors,
  },
})

// DELETE /api/mobile/events/{eventId}/favorite
registry.registerPath({
  method: "delete",
  path: "/api/mobile/events/{eventId}/favorite",
  tags: ["Mobile Events"],
  summary: "Unfavorite event",
  security: bearerAuth,
  request: { params: z.object({ eventId: z.string().uuid() }) },
  responses: {
    200: { description: "Unfavorited", content: { "application/json": { schema: wrap(FavoriteResponseSchema) } } },
    ...standardErrors,
  },
})

// GET /api/mobile/events/{eventId}/rating
registry.registerPath({
  method: "get",
  path: "/api/mobile/events/{eventId}/rating",
  tags: ["Mobile Events"],
  summary: "My rating of this event",
  description:
    "Your own rating only — there is no route that returns anyone else's. `rating` is null when you have not rated (including when you never attended; " +
    "the POST is what refuses). `ratedAt` is when you last set it. 404 `NOT_FOUND` for an unknown or deleted event.",
  security: bearerAuth,
  request: { params: z.object({ eventId: z.string().uuid() }) },
  responses: {
    200: {
      description: "Your rating",
      content: {
        "application/json": {
          schema: wrap(
            z.object({
              rating: z.number().int().min(1).max(5).nullable(),
              review: z.string().nullable(),
              ratedAt: z.string().datetime().nullable(),
            })
          ),
        },
      },
    },
    ...standardErrors,
  },
})

// POST /api/mobile/events/{eventId}/rating
registry.registerPath({
  method: "post",
  path: "/api/mobile/events/{eventId}/rating",
  tags: ["Mobile Events"],
  summary: "Rate event",
  description:
    "Anyone with a check-in row may rate, once the event has ended — attendance, not presence, so leaving the venue does not forfeit it. One row per person; rating again edits it. 403 for no check-in or an event still on.",
  security: bearerAuth,
  request: {
    params: z.object({ eventId: z.string().uuid() }),
    body: { content: { "application/json": { schema: RatingRequestSchema } } },
  },
  responses: {
    200: { description: "Rating submitted", content: { "application/json": { schema: wrap(RatingResponseSchema) } } },
    ...standardErrors,
  },
})


// GET /api/mobile/events/{eventId}/checkins
registry.registerPath({
  method: "get",
  path: "/api/mobile/events/{eventId}/checkins",
  tags: ["Mobile Events"],
  summary: "List event attendees",
  security: bearerAuth,
  request: {
    params: z.object({ eventId: z.string().uuid() }),
    query: z.object({ page: z.number().optional(), limit: z.number().optional() }),
  },
  responses: {
    200: { description: "Attendee list", content: { "application/json": { schema: wrap(AttendeeListResponseSchema) } } },
    ...standardErrors,
  },
})


// GET /api/mobile/events/{eventId}/matches
registry.registerPath({
  method: "get",
  path: "/api/mobile/events/{eventId}/matches",
  tags: ["Mobile Events"],
  summary: "Who else was in the room, ranked",
  description:
    "Only for people who checked in — 403 otherwise. Pseudonymous unless someone revealed themselves for this event. No score is exposed.",
  security: bearerAuth,
  request: {
    params: z.object({ eventId: z.string().uuid() }),
    query: z.object({ limit: z.number().optional() }),
  },
  responses: {
    200: { description: "Ranked matches", content: { "application/json": { schema: wrap(MatchListResponseSchema) } } },
    ...standardErrors,
  },
})

// POST /api/mobile/events/{eventId}/matches/likes
registry.registerPath({
  method: "post",
  path: "/api/mobile/events/{eventId}/matches/likes",
  tags: ["Mobile Events"],
  summary: "Like someone from this event",
  description:
    "A mutual like opens a conversation. The response never reveals whether the other person liked you first.\n\n" +
    "`userId` must be the handle this event's deck or roster gave you (SCRUM-371). A raw user id, another event's handle or a forged one is answered exactly as an unknown person — 404 `User not found` — because a raw-id like would say whether that account is in this room. Your own id is 400.",
  security: bearerAuth,
  request: {
    params: z.object({ eventId: z.string().uuid() }),
    body: { content: { "application/json": { schema: LikeRequestSchema } } },
  },
  responses: {
    200: { description: "Like recorded", content: { "application/json": { schema: wrap(LikeResponseSchema) } } },
    ...standardErrors,
  },
})

// GET /api/mobile/events/{eventId}/room-preview
registry.registerPath({
  method: "get",
  path: "/api/mobile/events/{eventId}/room-preview",
  tags: ["Mobile Events"],
  summary: "The room from the door: how many are here, how many share your taste",
  description:
    "Anyone who can open the event (404 otherwise). `hereCount` is distinct people checked in right now (the socket's `hereCount`, not `checkInCount`). `tasteMatchCount` counts those inside now and visible to you who share at least one interest; `null` when `hereCount` < 3, because a small count identifies people.",
  security: bearerAuth,
  request: { params: z.object({ eventId: z.string().uuid() }) },
  responses: {
    200: { description: "Preview", content: { "application/json": { schema: wrap(RoomPreviewResponseSchema) } } },
    ...standardErrors,
  },
})

// POST /api/mobile/events/{eventId}/waves
registry.registerPath({
  method: "post",
  path: "/api/mobile/events/{eventId}/waves",
  tags: ["Mobile Events"],
  summary: "Wave at someone in the room",
  description:
    "Ephemeral: emits `room:wave` to the recipient and stores nothing. Both people must be checked in now.\n\n" +
    "`toUserId` must be the handle this event's roster gave you (SCRUM-371). A raw user id, another event's handle or a forged one is answered exactly as somebody not in the room (403 `RECIPIENT_NOT_HERE`) and starts no window: a raw id asked who is here, and the per-pair window then told which handle it was. Your own id is 400.\n\n" +
    "**Error codes:** `VALIDATION_FAILED` (400, waving at yourself), `NOT_CHECKED_IN` (403, you), `RECIPIENT_NOT_HERE` (403 — not in the room, hidden, or a block either way; deliberately indistinguishable), `WAVE_TOO_SOON` (429, one per pair per 10 minutes, with `retryAfter`)",
  security: bearerAuth,
  request: {
    params: z.object({ eventId: z.string().uuid() }),
    body: { content: { "application/json": { schema: WaveRequestSchema } } },
  },
  responses: {
    200: { description: "Delivered to whoever has the app open", content: { "application/json": { schema: wrap(WaveResponseSchema) } } },
    ...standardErrors,
  },
})

// PUT /api/mobile/events/{eventId}/matches/preferences
registry.registerPath({
  method: "put",
  path: "/api/mobile/events/{eventId}/matches/preferences",
  tags: ["Mobile Events"],
  summary: "Set your intent and reveal for this event",
  security: bearerAuth,
  request: {
    params: z.object({ eventId: z.string().uuid() }),
    body: { content: { "application/json": { schema: MatchPreferencesSchema } } },
  },
  responses: {
    200: { description: "Saved", content: { "application/json": { schema: wrap(MatchPreferencesSchema) } } },
    ...standardErrors,
  },
})


// GET + POST /api/mobile/events/{eventId}/peer-ratings
registry.registerPath({
  method: "get",
  path: "/api/mobile/events/{eventId}/peer-ratings",
  tags: ["Mobile Events"],
  summary: "Who you can still rate for this event",
  description:
    "Only people you connected with (a mutual like), and only once the event has ended. Empty is the common case.",
  security: bearerAuth,
  request: { params: z.object({ eventId: z.string().uuid() }) },
  responses: {
    200: { description: "Ratable peers", content: { "application/json": { schema: wrap(RatablePeersResponseSchema) } } },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "post",
  path: "/api/mobile/events/{eventId}/peer-ratings",
  tags: ["Mobile Events"],
  summary: "Rate someone you met",
  description:
    "Never visible to the person rated, and no endpoint returns it to them. A harassment report goes to moderation on its own and is never averaged into a score.",
  security: bearerAuth,
  request: {
    params: z.object({ eventId: z.string().uuid() }),
    body: { content: { "application/json": { schema: PeerRatingRequestSchema } } },
  },
  responses: {
    200: { description: "Recorded", content: { "application/json": { schema: wrap(z.object({ recorded: z.boolean() })) } } },
    ...standardErrors,
  },
})


// GET /api/mobile/events/{eventId}/interested-users
registry.registerPath({
  method: "get",
  path: "/api/mobile/events/{eventId}/interested-users",
  tags: ["Mobile Events"],
  summary: "List interested users",
  security: bearerAuth,
  request: {
    params: z.object({ eventId: z.string().uuid() }),
    query: z.object({ page: z.number().optional(), limit: z.number().optional() }),
  },
  responses: {
    200: { description: "Interested users", content: { "application/json": { schema: wrap(InterestedUsersResponseSchema) } } },
    ...standardErrors,
  },
})


// POST /api/mobile/events/{eventId}/announce
registry.registerPath({
  method: "post",
  path: "/api/mobile/events/{eventId}/announce",
  tags: ["Mobile Events"],
  summary: "Send announcement (organizer only)",
  security: bearerAuth,
  request: {
    params: z.object({ eventId: z.string().uuid() }),
    body: { content: { "application/json": { schema: AnnounceRequestSchema } } },
  },
  responses: {
    200: { description: "Announcement sent", content: { "application/json": { schema: wrap(z.object({ id: z.string().uuid() })) } } },
    ...standardErrors,
  },
})

// GET /api/mobile/events/{eventId}/chat
registry.registerPath({
  method: "get",
  path: "/api/mobile/events/{eventId}/chat",
  tags: ["Mobile Events"],
  summary: "Get event chat messages (must be checked in)",
  description: "Returns paginated messages. Moderation-hidden messages are included for the sender only, with `content: null` and `moderation_hidden: true` — render these as placeholders. A non-member is joined if entitled (checked in, or RSVP inside the pre-event window); a `banned` member is refused 403 `USER_BANNED` instead of being served the room; a draft event answers 404. Somebody who left the room themselves is NOT rejoined: 403 `LEFT_ROOM` with `chatGroupId` in the body (rejoin with `DELETE /chat/groups/{chatGroupId}/leave`, or by checking in). `mute` is your own mute of the room's pushes.",
  security: bearerAuth,
  request: {
    params: z.object({ eventId: z.string().uuid() }),
    query: z.object({
      page: z.number().optional(),
      limit: z.number().optional(),
      before: z.string().datetime().optional(),
      after: z.string().datetime().optional(),
    }),
  },
  responses: {
    200: { description: "Chat messages", content: { "application/json": { schema: wrap(EventChatResponseSchema) } } },
    ...standardErrors,
  },
})

// POST /api/mobile/events/{eventId}/chat
registry.registerPath({
  method: "post",
  path: "/api/mobile/events/{eventId}/chat",
  tags: ["Mobile Events"],
  summary: "Send event chat message (must be checked in)",
  description: [
    "Send a message to an event chat. Same moderation pipeline as group chat:",
    "",
    "1. **Spam check** → 2. **Keyword filter** (instant) → 3. **OpenAI Moderation** (1s timeout)",
    "",
    "If caught, response has `moderation_hidden: true`, `content: null`. Message is never broadcast.",
    "",
    "**Error codes:** `USER_MUTED` (403), `USER_BANNED` (403), `NOT_CHECKED_IN` (403), `SPAM_BLOCKED` (429)",
  ].join("\n"),
  security: bearerAuth,
  request: {
    params: z.object({ eventId: z.string().uuid() }),
    body: { content: { "application/json": { schema: SendMessageRequestSchema } } },
  },
  responses: {
    201: { description: "Message sent (check `moderation_hidden` — if true, content was blocked)", content: { "application/json": { schema: wrap(z.object({ message: ChatMessageSchema })) } } },
    ...standardErrors,
  },
})

// Batch operations
registry.registerPath({
  method: "post",
  path: "/api/mobile/events/checkins/batch",
  tags: ["Mobile Events"],
  summary: "Batch check-in status lookup",
  description: "Get check-in status for multiple events at once. Max 50 event IDs.",
  security: bearerAuth,
  request: { body: { content: { "application/json": { schema: BatchEventIdsSchema } } } },
  responses: {
    200: { description: "Batch statuses", content: { "application/json": { schema: wrap(BatchCheckinsResponseSchema) } } },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "post",
  path: "/api/mobile/events/interests/batch",
  tags: ["Mobile Events"],
  summary: "Batch interest status lookup",
  description: "Get interest status for multiple events. Max 50 event IDs.",
  security: bearerAuth,
  request: { body: { content: { "application/json": { schema: BatchEventIdsSchema } } } },
  responses: {
    200: { description: "Batch interests", content: { "application/json": { schema: wrap(BatchInterestsResponseSchema) } } },
    ...standardErrors,
  },
})

registry.registerPath({
  method: "post",
  path: "/api/mobile/events/interest-counts/batch",
  tags: ["Mobile Events"],
  summary: "Batch interest count lookup",
  description: "Get interest counts for multiple events. Max 50 event IDs.",
  security: bearerAuth,
  request: { body: { content: { "application/json": { schema: BatchEventIdsSchema } } } },
  responses: {
    200: { description: "Batch counts", content: { "application/json": { schema: wrap(BatchInterestCountsResponseSchema) } } },
    ...standardErrors,
  },
})

// === The board's requests ===

registry.registerPath({
  method: "post",
  path: "/api/mobile/events/{eventId}/board/{postId}/requests",
  tags: ["Mobile Events"],
  summary: "Ask to come with somebody",
  description:
    "A request is always filed against a post, and the recipient is read off " +
    "that post — so somebody who has not put themselves forward cannot be " +
    "asked at all. Same gates as posting: RSVP 'going', a complete profile, " +
    "and room under both caps. One ask per post, ever: any earlier ask — " +
    "waiting, declined, withdrawn or accepted — is a 409 \"You have already " +
    "asked — give them a moment\", the same sentence whatever became of it, so " +
    "the refusal never tells the asker they were declined. A post by somebody " +
    "blocked either way is the same 404 as a post that is gone. A `chat` post " +
    "takes no requests (422); an offer at `spacesLeft: 0` is 409 \"That offer " +
    "is full\". Closed once the doors open (403). A `message` " +
    "gets the post's moderation checks; a hit is a 422 and nothing is sent.",
  security: bearerAuth,
  request: {
    params: z.object({ eventId: z.string(), postId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            message: z.string().max(300).optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Sent, and waiting on them",
      content: {
        "application/json": {
          schema: wrap(
            z.object({
              id: z.string(),
              status: z.enum(["pending", "accepted", "declined", "withdrawn"]),
              createdAt: z.string(),
            })
          ),
        },
      },
    },
    ...standardErrors,
    409: {
      description:
        "\"You have already asked — give them a moment\" (any earlier ask on this post, " +
        "whatever became of it), or \"That offer is full\"",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    422: {
      description: "The message was refused by moderation, or the post is a `chat` post; nothing sent",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
})

const boardRequest = z.object({
  id: z.string(),
  status: z.enum(["pending", "accepted", "declined", "withdrawn"]),
  message: z.string().nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  /**
   * Still answerable: pending, its event not ended, its post not taken down.
   * To the asker, also false once either of the two has blocked the other —
   * their row then reads as an ask on a withdrawn post (`post.body` null).
   */
  live: z.boolean(),
  /** The pseudonym at that event, never the name. Accepting exchanges those. */
  counterpart: z.string(),
  event: z.object({ id: z.string(), title: z.string(), startTime: z.string() }),
  post: z.object({
    id: z.string(),
    kind: z.enum(["offer", "seeking", "chat"]),
    /** Null once the post is withdrawn or removed — its words leave with it. */
    body: z.string().nullable(),
  }),
})

registry.registerPath({
  method: "get",
  path: "/api/mobile/board/requests",
  tags: ["Mobile Events"],
  summary: "Your board requests, both directions",
  description:
    "Not scoped to an event: a request is answered from a notification days " +
    "after the board was last opened. Pending first, then newest — a decided " +
    "request is history and an undecided one is a person waiting. A decline is " +
    "never delivered: in `outgoing` a declined ask reads `status: \"pending\"`, " +
    "`decidedAt: null`, live until it lapses with its event or post, and sorts " +
    "with the pending ones — `declined` only ever appears in `incoming`. A " +
    "declined ask the asker withdrew reads `withdrawn` to them and `declined` to " +
    "the author. Asks from somebody blocked either way are left out of " +
    "`incoming`; in `outgoing` an ask to them reads as an ask on a withdrawn " +
    "post. Each direction lists live asks first, then settled, then lapsed, up " +
    "to 50.",
  security: bearerAuth,
  responses: {
    200: {
      description: "What is waiting on you, and what you are waiting on",
      content: {
        "application/json": {
          schema: wrap(
            z.object({
              incoming: z.array(boardRequest),
              outgoing: z.array(boardRequest),
            })
          ),
        },
      },
    },
    ...standardErrors,
  },
})

// === Reporting and blocking from the board (SCRUM-322) ===

const boardReportBody = {
  body: {
    content: {
      "application/json": {
        schema: z.object({
          reason: z.enum(["harassment", "hate_speech", "inappropriate_content", "spam", "other"]),
          description: z.string().max(500).optional(),
        }),
      },
    },
  },
}
const reported = {
  description: "Report filed",
  content: { "application/json": { schema: wrap(z.object({ reported: z.literal(true) })) } },
}
const blocked = {
  description: "Blocked — the same transaction and response as POST /users/{userId}/block",
  content: { "application/json": { schema: wrap(z.object({ blocked: z.literal(true) })) } },
}
const BY_POST =
  "The board never gives the client a user id, so the author is resolved on the server " +
  "and never returned. Allowed for anyone who can read this event's board (RSVP'd or " +
  "favourited) or has an ask on the post — a withdrawn or removed post included. " +
  "Anything else, including no such post, is 404. Your own post is 400."

registry.registerPath({
  method: "post",
  path: "/api/mobile/events/{eventId}/board/{postId}/report",
  tags: ["Mobile Events"],
  summary: "Report a board post",
  description:
    BY_POST +
    " Lands in the admin reports queue as \"Board · offer|seeking|chat\" (stored in " +
    "`message_reports` as `message_type: \"board_post\"`). Rate limited per user.",
  security: bearerAuth,
  request: { params: z.object({ eventId: z.string(), postId: z.string() }), ...boardReportBody },
  responses: { 201: reported, ...standardErrors },
})

registry.registerPath({
  method: "post",
  path: "/api/mobile/events/{eventId}/board/{postId}/block",
  tags: ["Mobile Events"],
  summary: "Block a board post's author",
  description: BY_POST + " Then exactly POST /users/{userId}/block for that author.",
  security: bearerAuth,
  request: { params: z.object({ eventId: z.string(), postId: z.string() }) },
  responses: { 200: blocked, ...standardErrors },
})

registry.registerPath({
  method: "post",
  path: "/api/mobile/board/requests/{requestId}/report",
  tags: ["Mobile Events"],
  summary: "Report a board ask",
  description:
    "Either of the ask's two people may report it; the report is about the other one, " +
    "resolved on the server and never returned. Anyone else, or no such ask, is 404. Lands " +
    "in the admin reports queue as \"Board ask\" (`message_type: \"board_request\"`). " +
    "Rate limited per user.",
  security: bearerAuth,
  request: { params: z.object({ requestId: z.string() }), ...boardReportBody },
  responses: { 201: reported, ...standardErrors },
})

registry.registerPath({
  method: "post",
  path: "/api/mobile/board/requests/{requestId}/block",
  tags: ["Mobile Events"],
  summary: "Block the other person on a board ask",
  description:
    "Either of the ask's two people may block the other, by the ask. Anyone else, or no " +
    "such ask, is 404. Then exactly POST /users/{userId}/block for that person.",
  security: bearerAuth,
  request: { params: z.object({ requestId: z.string() }) },
  responses: { 200: blocked, ...standardErrors },
})

registry.registerPath({
  method: "patch",
  path: "/api/mobile/board/requests/{requestId}",
  tags: ["Mobile Events"],
  summary: "Answer a board request",
  description:
    "Accept or decline if you were asked; withdraw if you did the asking — " +
    "'withdrawn' is a separate status from 'declined' because afterwards, " +
    "which of the two people ended it is the thing worth knowing. Accepting " +
    "opens a pseudonymous conversation scoped to the event, marked with its " +
    "board request so the client can tell it from a match. Still possible " +
    "after the doors open: a pending request holds a slot in the asker's cap, " +
    "so an unanswerable one would consume it for ever. Accepting an `offer` " +
    "with a number of seats spends one atomically; the last seat goes to " +
    "exactly one accept and the other is 409 \"That offer is full\" (the ask " +
    "stays pending). Withdrawing succeeds on a pending or declined ask and " +
    "again on a withdrawn one — a decline is never delivered to the asker, " +
    "so withdrawing one cannot be the place it lands; only an accepted ask is 409.",
  security: bearerAuth,
  request: {
    params: z.object({ requestId: z.string() }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ action: z.enum(["accept", "decline", "withdraw"]) }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Answered. `conversationId` is present only on accept.",
      content: {
        "application/json": {
          schema: wrap(
            z.object({
              id: z.string(),
              status: z.enum(["accepted", "declined", "withdrawn"]),
              conversationId: z.string().optional(),
            })
          ),
        },
      },
    },
    ...standardErrors,
    409: {
      description:
        "Accept refused, the ask left pending: \"That request has already been answered\", " +
        "\"That post was taken down\", \"That event has ended\", \"That offer is full\", or " +
        "\"This request can no longer be accepted\" (a block either way or a closed pair — " +
        "one answer for both). Withdraw: only an accepted ask is refused.",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
})
