import { z } from "zod"
import { registry } from "@/lib/openapi/registry"
import { PaginationMetaSchema, DeviceInfoSchema } from "./common"

// Request schemas
export const EventQuerySchema = z
  .object({
    page: z.number().int().min(1).default(1),
    limit: z.number().int().min(1).max(100).default(20),
    search: z.string().optional(),
    city: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .openapi({
        description:
          "Scope the list to one city, matched case-insensitively against the event's city. This is how a browse screen is scoped; `search` is a fuzzy match across four columns and is not a scope. Pick a value from GET /api/mobile/events/cities.",
      }),
    lat: z.number().min(-90).max(90).optional(),
    lon: z.number().min(-180).max(180).optional(),
    radius: z
      .number()
      .min(0.1)
      .max(100)
      .optional()
      .openapi({
        description:
          "Hard-limit results to this many km from lat/lon. **No default** — sending coordinates alone sorts and labels by distance without excluding anything. Only pass this for a genuinely bounded search.",
      }),
    categoryId: z.string().uuid().optional(),
    categorySlug: z.string().optional(),
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
    includePast: z
      .boolean()
      .default(false)
      .openapi({
        description:
          "Include events that have already ended. Off by default — discovery only returns events you can still go to. Set true for history screens.",
      }),
    status: z.enum(["draft", "published", "cancelled", "completed"]).optional(),
    sortBy: z.enum(["start_time", "created_at", "distance"]).default("start_time"),
    sortOrder: z.enum(["asc", "desc"]).default("asc"),
    include: z.string().optional().openapi({ description: "Comma-separated: checkins,activeCheckins,profile" }),
    /** @deprecated Accepted and ignored — `interestedPreview` was removed. */
    interestedPreviewLimit: z.number().int().min(1).max(6).optional(),
  })
  .openapi("EventQuery")

export const CheckinRequestSchema = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    deviceInfo: DeviceInfoSchema.extend({
      gpsAccuracy: z.number().optional(),
    }).optional(),
  })
  .openapi("CheckinRequest")

export const RatingRequestSchema = z
  .object({
    rating: z.number().int().min(1).max(5),
    review: z.string().max(1000).optional(),
  })
  .openapi("RatingRequest")

export const RsvpRequestSchema = z
  .object({
    status: z.enum(["going", "maybe", "not_going"]).default("going"),
  })
  .openapi("RsvpRequest")

export const AnnounceRequestSchema = z
  .object({
    content: z.string().max(1000),
  })
  .openapi("AnnounceRequest")

export const BatchEventIdsSchema = z
  .object({
    eventIds: z.array(z.string().uuid()).min(1).max(50),
  })
  .openapi("BatchEventIds")

export const EventSearchQuerySchema = z
  .object({
    q: z.string().min(1).max(200),
    city: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .openapi({
        description:
          "Scope results to one city, matching GET /api/mobile/events. Omit to search everywhere.",
      }),
    page: z.number().int().min(1).default(1).optional(),
    limit: z.number().int().min(1).max(100).default(20).optional(),
  })
  .openapi("EventSearchQuery")

export const CityDemandRequestSchema = z
  .object({
    city: z.string().min(1).max(100).openapi({
      description:
        "The city the device is in, as the client resolved it. Stored normalised, so case and spacing do not matter.",
    }),
    country: z.string().min(1).max(100).optional(),
  })
  .openapi("CityDemandRequest")

export const EventCitiesResponseSchema = z
  .object({
    cities: z.array(
      z.object({
        city: z.string().openapi({ description: "Pass this back as the `city` query parameter." }),
        eventCount: z.number().int(),
      })
    ),
  })
  .openapi("EventCitiesResponse")

// Response schemas
const OrganizerSchema = z.object({
  id: z.string(),
  name: z.string(),
  image: z.string().nullable(),
  // No email. A host's public identity is their name and picture; the address
  // was returned by the detail endpoint only, and is no longer sent.
})

const EventCategorySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  icon: z.string().nullable(),
  parent: z
    .object({
      id: z.string().uuid(),
      name: z.string(),
      slug: z.string(),
    })
    .nullable()
    .openapi({
      description:
        "The parent category, or null if this one is top level. Events are tagged to leaves — an event is 'Classical and Carnatic', never 'Music' — so group by this when you want a whole family rather than one leaf.",
    }),
})

const EventStatsSchema = z.object({
  checkInCount: z.number(),
  favoriteCount: z.number(),
  ratingCount: z.number(),
  averageRating: z.number().nullable(),
  rsvpCount: z.number().optional(),
})

const UserStatusSchema = z.object({
  isFavorited: z.boolean(),
  isCheckedIn: z.boolean(),
  checkInStatus: z.string().nullable(),
  userRating: z.number().nullable(),
  userReview: z.string().nullable(),
  rsvpStatus: z.string().nullable(),
})

export const EventSummarySchema = z
  .object({
    id: z.string().uuid(),
    slug: z.string(),
    title: z.string(),
    shortDescription: z.string().nullable(),
    coverImageUrl: z.string().nullable(),
    startTime: z.string().datetime(),
    endTime: z.string().datetime(),
    venueName: z.string().nullable(),
    city: z.string().nullable(),
    status: z.string(),
  })
  .openapi("EventSummary")

export const EventDetailSchema = z
  .object({
    id: z.string().uuid(),
    slug: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    shortDescription: z.string().nullable(),
    coverImageUrl: z.string().nullable(),
    startTime: z.string().datetime(),
    endTime: z.string().datetime(),
    timezone: z.string(),
    status: z.string(),
    visibility: z.string(),
    venueName: z.string().nullable(),
    address: z.string().nullable(),
    city: z.string().nullable(),
    state: z.string().nullable(),
    country: z.string().nullable(),
    postalCode: z.string().nullable(),
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
    maxCapacity: z.number().nullable(),
    /** Null for almost every event. Enforced at check-in, not on this response. */
    minAge: z.number().nullable(),
    currentCapacity: z.number(),
    checkInRadius: z.number(),
    isFeatured: z.boolean(),
    isRecurring: z.boolean(),
    externalLink: z.string().nullable(),
    createdAt: z.string().datetime(),
    organizer: OrganizerSchema,
    categories: z.array(EventCategorySchema),
    media: z.array(z.object({ id: z.string(), url: z.string(), type: z.string() })),
    chatGroup: z.object({
      id: z.string().uuid(),
      name: z.string(),
      status: z.string(),
      memberCount: z.number(),
    }).nullable(),
    stats: EventStatsSchema,
    userStatus: UserStatusSchema,
    distance: z.number().optional(),
  })
  .openapi("EventDetail")

export const EventListResponseSchema = z
  .object({
    events: z.array(z.unknown().openapi({ description: "Transformed event objects" })),
    pagination: PaginationMetaSchema,
    activeCheckins: z.array(z.unknown()).optional(),
    profile: z.unknown().optional(),
  })
  .openapi("EventListResponse")

export const CheckinResponseSchema = z
  .object({
    checkIn: z.object({
      id: z.string().uuid(),
      status: z.string(),
      checkInTime: z.string().datetime(),
      eventId: z.string().uuid(),
    }),
    /**
     * Offer to name them here — a *suggestion*, never a state.
     *
     * True when `profiles.reveal_by_default` is set. Check-in always creates
     * `revealed: false`; the app asks "you usually join as Sagar, do that
     * here?" and a tap applies it.
     */
    revealSuggestion: z.boolean(),
    message: z.string(),
  })
  .openapi("CheckinResponse")

export const CheckoutResponseSchema = z
  .object({
    message: z.string(),
    checkIn: z.object({
      id: z.string().uuid(),
      status: z.string(),
      checkInTime: z.string().datetime(),
      checkOutTime: z.string().datetime(),
      event: z.object({ id: z.string().uuid(), title: z.string() }),
    }),
  })
  .openapi("CheckoutResponse")

export const RsvpResponseSchema = z
  .object({
    rsvpStatus: z.string().nullable(),
    rsvpCount: z.number(),
  })
  .openapi("RsvpResponse")

export const InterestResponseSchema = z
  .object({
    interested: z.boolean(),
    interestCount: z.number(),
  })
  .openapi("InterestResponse")

export const FavoriteResponseSchema = z
  .object({
    isFavorited: z.boolean(),
    favoriteCount: z.number(),
    message: z.string(),
  })
  .openapi("FavoriteResponse")

export const RatingResponseSchema = z
  .object({
    rating: z.object({
      id: z.string().uuid(),
      rating: z.number(),
      review: z.string().nullable(),
      createdAt: z.string().datetime(),
      updatedAt: z.string().datetime(),
    }),
    eventStats: z.object({
      averageRating: z.number(),
      ratingCount: z.number(),
    }),
    message: z.string(),
  })
  .openapi("RatingResponse")

export const ConnectionMetricsSchema = z
  .object({
    attendees: z.number(),
    /** Mutual likes — pairs where both people said yes. */
    connections: z.number(),
    connected: z.number(),
    /** The industry benchmark figure. Null when suppressed. */
    perAttendee: z.number().nullable(),
    connectedPct: z.number().nullable(),
    /**
     * Too few attendees for these to be aggregates rather than facts about
     * named people. Everything derived is null; `attendees` still shows.
     */
    suppressed: z.boolean(),
  })
  .openapi("ConnectionMetrics")

export const AnalyticsResponseSchema = z
  .object({
    eventId: z.string().uuid(),
    summary: z.object({
      totalCheckIns: z.number(),
      checkedInNow: z.number(),
      totalInterested: z.number(),
      totalRatings: z.number(),
      averageRating: z.number().nullable(),
      conversionRate: z.number(),
      capacityUsed: z.number(),
    }),
    /** Whether anyone actually met anyone. Suppressed for small rooms. */
    connections: ConnectionMetricsSchema,
    checkInTimeline: z.array(
      z.object({ hour: z.string(), count: z.number() })
    ),
  })
  .openapi("AnalyticsResponse")

export const CloneResponseSchema = z
  .object({
    id: z.string().uuid(),
    slug: z.string(),
    title: z.string(),
    status: z.literal("draft"),
  })
  .openapi("CloneResponse")

export const BatchCheckinsResponseSchema = z
  .object({
    statuses: z.record(
      z.string(),
      z.object({
        status: z.string(),
        checkInId: z.string().optional(),
        checkInTime: z.string().datetime().optional(),
      })
    ),
  })
  .openapi("BatchCheckinsResponse")

export const BatchInterestsResponseSchema = z
  .object({
    interests: z.record(z.string(), z.boolean()),
  })
  .openapi("BatchInterestsResponse")

export const BatchInterestCountsResponseSchema = z
  .object({
    counts: z.record(z.string(), z.number()),
  })
  .openapi("BatchInterestCountsResponse")



export const PeerRatingRequestSchema = z
  .object({
    userId: z.string(),
    rating: z.number().int().min(1).max(5),
    issue: z.enum(["none", "uncomfortable", "no_show", "misrepresented", "harassment"]).optional(),
    /** Read only by moderation. Never rendered to another attendee. */
    note: z.string().max(1000).optional(),
  })
  .openapi("PeerRatingRequest")

export const RatablePeersResponseSchema = z
  .object({
    /** Everyone you connected with at this event and have not yet rated. */
    userIds: z.array(z.string()),
  })
  .openapi("RatablePeersResponse")

export const MatchListResponseSchema = z
  .object({
    matches: z.array(
      z.object({
        userId: z.string(),
        /** Room pseudonym unless that person revealed themselves at this event. */
        displayName: z.string(),
        /** Null unless revealed — a photo identifies as surely as a name. */
        photo: z.string().nullable(),
        /** Category names, which is what the card renders. */
        sharedInterests: z.array(z.string()),
        sharedIntents: z.array(z.enum(["dating", "networking", "friendship", "just_here"])),
        /**
         * A label — "Design", never a slug and never an employer. Null when
         * they have not said, and null in rooms below eight people, where an
         * age, a city and a field of work name one person.
         */
        workField: z.string().nullable(),
        insideNow: z.boolean(),
        /** Whether you liked them. Never whether they liked you. */
        youLiked: z.boolean(),
      })
    ),
  })
  .openapi("MatchListResponse")

export const LikeRequestSchema = z
  .object({ userId: z.string() })
  .openapi("LikeRequest")

export const LikeResponseSchema = z
  .object({ mutual: z.boolean(), conversationId: z.string().optional() })
  .openapi("LikeResponse")

export const MatchPreferencesSchema = z
  .object({
    intent: z.array(z.enum(["dating", "networking", "friendship", "just_here"])).optional(),
    revealed: z.boolean().optional(),
    /** Writes `profiles.intent_default`. */
    rememberIntent: z.boolean().optional(),
    /** Writes `profiles.reveal_by_default` — the *suggestion*, not a state. */
    rememberReveal: z.boolean().optional(),
    /** @deprecated Means both. Kept for builds already in the store. */
    /** Also write the profile default, not just this event. */
    remember: z.boolean().optional(),
  })
  .openapi("MatchPreferences")

export const AttendeeListResponseSchema = z
  .object({
    attendees: z.array(
      z.object({
        userId: z.string(),
        /**
         * The room pseudonym ("Cosmic Panda"), not the real name — the same one
         * this person carries in the event chat. `image` is deliberately absent:
         * a photo identifies as surely as a name.
         */
        name: z.string(),
        age: z.number().nullable(),
        location: z.string().nullable(),
        checkInTime: z.string().datetime(),
      })
    ),
    pagination: PaginationMetaSchema,
  })
  .openapi("AttendeeListResponse")

export const InterestedUsersResponseSchema = z
  .object({
    users: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        avatar: z.string().nullable(),
      })
    ),
    pagination: PaginationMetaSchema,
  })
  .openapi("InterestedUsersResponse")

// Register all
const schemas = {
  EventQuery: EventQuerySchema,
  CheckinRequest: CheckinRequestSchema,
  RatingRequest: RatingRequestSchema,
  RsvpRequest: RsvpRequestSchema,
  AnnounceRequest: AnnounceRequestSchema,
  BatchEventIds: BatchEventIdsSchema,
  EventSearchQuery: EventSearchQuerySchema,
  EventSummary: EventSummarySchema,
  EventDetail: EventDetailSchema,
  EventListResponse: EventListResponseSchema,
  CheckinResponse: CheckinResponseSchema,
  CheckoutResponse: CheckoutResponseSchema,
  RsvpResponse: RsvpResponseSchema,
  InterestResponse: InterestResponseSchema,
  FavoriteResponse: FavoriteResponseSchema,
  RatingResponse: RatingResponseSchema,
  AnalyticsResponse: AnalyticsResponseSchema,
  CloneResponse: CloneResponseSchema,
  BatchCheckinsResponse: BatchCheckinsResponseSchema,
  BatchInterestsResponse: BatchInterestsResponseSchema,
  BatchInterestCountsResponse: BatchInterestCountsResponseSchema,
  AttendeeListResponse: AttendeeListResponseSchema,
  ConnectionMetrics: ConnectionMetricsSchema,
  PeerRatingRequest: PeerRatingRequestSchema,
  RatablePeersResponse: RatablePeersResponseSchema,
  MatchListResponse: MatchListResponseSchema,
  LikeRequest: LikeRequestSchema,
  LikeResponse: LikeResponseSchema,
  MatchPreferences: MatchPreferencesSchema,
  InterestedUsersResponse: InterestedUsersResponseSchema,
}

for (const [name, schema] of Object.entries(schemas)) {
  registry.register(name, schema)
}
