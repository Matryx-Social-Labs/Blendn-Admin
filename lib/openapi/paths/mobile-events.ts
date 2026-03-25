import { z } from "zod"
import { registry } from "@/lib/openapi/registry"
import { standardErrors } from "@/lib/openapi/schemas/common"
import {
  EventQuerySchema,
  CheckinRequestSchema,
  RatingRequestSchema,
  RsvpRequestSchema,
  AnnounceRequestSchema,
  BatchEventIdsSchema,
  EventSearchQuerySchema,
  EventListResponseSchema,
  EventDetailSchema,
  CheckinResponseSchema,
  CheckoutResponseSchema,
  RsvpResponseSchema,
  InterestResponseSchema,
  FavoriteResponseSchema,
  RatingResponseSchema,
  AnalyticsResponseSchema,
  CloneResponseSchema,
  BatchCheckinsResponseSchema,
  BatchInterestsResponseSchema,
  BatchInterestCountsResponseSchema,
  AttendeeListResponseSchema,
  InterestedUsersResponseSchema,
  EventSummarySchema,
} from "@/lib/openapi/schemas/event"
import { EventChatResponseSchema, SendMessageRequestSchema, ChatMessageSchema } from "@/lib/openapi/schemas/chat"

const bearerAuth = [{ BearerAuth: [] }]
const wrap = (schema: z.ZodTypeAny) => z.object({ success: z.literal(true), data: schema })

// GET /api/mobile/events
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
  description: "GPS-verified check-in. Must be within event's check-in radius. Max GPS accuracy: 150m.",
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

// POST /api/mobile/events/{eventId}/rsvp
registry.registerPath({
  method: "post",
  path: "/api/mobile/events/{eventId}/rsvp",
  tags: ["Mobile Events"],
  summary: "RSVP to event",
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

// POST /api/mobile/events/{eventId}/rating
registry.registerPath({
  method: "post",
  path: "/api/mobile/events/{eventId}/rating",
  tags: ["Mobile Events"],
  summary: "Rate event",
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

// GET /api/mobile/events/{eventId}/analytics
registry.registerPath({
  method: "get",
  path: "/api/mobile/events/{eventId}/analytics",
  tags: ["Mobile Events"],
  summary: "Get event analytics (organizer/admin)",
  security: bearerAuth,
  request: { params: z.object({ eventId: z.string().uuid() }) },
  responses: {
    200: { description: "Analytics data", content: { "application/json": { schema: wrap(AnalyticsResponseSchema) } } },
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

// GET /api/mobile/events/{eventId}/checkins/export
registry.registerPath({
  method: "get",
  path: "/api/mobile/events/{eventId}/checkins/export",
  tags: ["Mobile Events"],
  summary: "Export attendees as CSV (organizer/admin)",
  security: bearerAuth,
  request: { params: z.object({ eventId: z.string().uuid() }) },
  responses: {
    200: { description: "CSV file", content: { "text/csv": { schema: z.string() } } },
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

// POST /api/mobile/events/{eventId}/clone
registry.registerPath({
  method: "post",
  path: "/api/mobile/events/{eventId}/clone",
  tags: ["Mobile Events"],
  summary: "Clone event (organizer/admin)",
  security: bearerAuth,
  request: { params: z.object({ eventId: z.string().uuid() }) },
  responses: {
    201: { description: "Cloned event", content: { "application/json": { schema: wrap(CloneResponseSchema) } } },
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
  description: "Returns paginated messages. Moderation-hidden messages are included for the sender only, with `content: null` and `moderation_hidden: true` — render these as placeholders.",
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
