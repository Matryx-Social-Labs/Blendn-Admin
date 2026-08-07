import { z } from "zod"
import { registry } from "@/lib/openapi/registry"
import { PaginationMetaSchema, DeviceInfoSchema } from "./common"

// Request schemas
export const EventQuerySchema = z
  .object({
    page: z.number().int().min(1).default(1),
    limit: z.number().int().min(1).max(100).default(20),
    search: z.string().optional(),
    lat: z.number().min(-90).max(90).optional(),
    lon: z.number().min(-180).max(180).optional(),
    radius: z.number().min(0.1).max(100).default(10),
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
    include: z.string().optional().openapi({ description: "Comma-separated: checkins,interestedPreview,activeCheckins,profile" }),
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
    page: z.number().int().min(1).default(1).optional(),
    limit: z.number().int().min(1).max(100).default(20).optional(),
  })
  .openapi("EventSearchQuery")

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
  InterestedUsersResponse: InterestedUsersResponseSchema,
}

for (const [name, schema] of Object.entries(schemas)) {
  registry.register(name, schema)
}
