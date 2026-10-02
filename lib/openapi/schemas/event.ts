import { z } from "zod"
import { registry } from "@/lib/openapi/registry"
import { PaginationMetaSchema, DeviceInfoSchema, RoomUserRefSchema } from "./common"

/** Likes and waves name somebody only by this event's handle (SCRUM-371). */
const ThisRoomRefSchema = z.string().min(1).openapi({
  description:
    "The room handle (`rh_…`) this event's roster or deck gave for the person. A raw user id or another event's handle is answered as an unknown person.",
})

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
    /**
     * Which of the three non-user message kinds this is.
     *
     * The route has always read `kind` and gated it through `canBroadcast`
     * (`announce/route.ts`), and the spec documented only `content` — so a
     * generated client could send an announcement and nothing else, and had no
     * way to discover that `sponsored` and `system` existed or that they are
     * gated differently.
     *
     * Defaults to `announcement`, matching the route's own fallback for an
     * unrecognised value.
     */
    kind: z.enum(["announcement", "sponsored", "system"]).default("announcement"),
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
  id: z.string().nullable().openapi({
    description: "Null when the host is the platform itself (a curated event); `image` is then null too.",
  }),
  name: z.string(),
  image: z.string().nullable(),
  // No email. A host's public identity is their name and picture; the address
  // was returned by the detail endpoint only, and is no longer sent.
})

// The leaf the event is tagged to, as stored. No parent is sent (SCRUM-460).
const EventCategorySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  icon: z.string().nullable(),
})

const EventStatsSchema = z.object({
  checkInCount: z.number(),
  favoriteCount: z.number(),
  ratingCount: z.number(),
  rsvpCount: z.number().openapi({ description: "RSVPs with status `going`." }),
})

const UserStatusSchema = z.object({
  isFavorited: z.boolean(),
  isCheckedIn: z.boolean(),
  checkInStatus: z.string().nullable(),
  userRating: z.number().nullable(),
  userReview: z.string().nullable(),
  rsvpStatus: z.string().nullable(),
})

/**
 * The window the app judges "live" and "ended" by — `lib/occurrences.ts`
 * `eventSession`. `startTime`/`endTime` are the whole run.
 */
export const EventSessionSchema = z
  .object({
    startTime: z.string().datetime(),
    endTime: z.string().datetime(),
  })
  .nullable()
  .openapi("EventSession", {
    description:
      "The day of the event the app should talk about now: the one running, else the next one going ahead, else the last one that went ahead (so it reads as ended). Null when every day is cancelled. On a single-day event it equals startTime/endTime. Judge LIVE / Happening now / check-in by this, not by startTime/endTime, which span the whole run.",
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
    session: EventSessionSchema,
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
    /**
     * Metres around latitude/longitude that hold the whole check-in area and its
     * buffer — derived from the event's geofence (a copy of its venue's, taken on save), not stored
     * (SCRUM-350). The door judges the real area; this circle only contains it.
     */
    checkInRadius: z.number().openapi({
      description:
        "Radius in metres around latitude/longitude that contains the whole check-in area (outline or circle) plus its buffer. Derived from the event's geofence, which is a copy of its venue's taken when the event was saved. The server judges check-in against the real area; this circle only contains it.",
    }),
    isFeatured: z.boolean(),
    isRecurring: z.boolean(),
    doorPolicy: z.enum(["open", "guest_list", "members_only", "invite_only"]).openapi({
      description:
        "The organiser's description of the door, not a gate this API keeps. `open` for almost every event, and draws nothing.",
    }),
    externalLink: z.string().nullable(),
    createdAt: z.string().datetime(),
    organizer: OrganizerSchema,
    claim: z
      .object({
        url: z.string().url().openapi({
          example: "https://dashboard.blendn.app/claim/3f0b6d1e-8a52-4c1f-9e1a-2b7c4d5e6f70",
        }),
      })
      .nullable()
      .openapi({
        description:
          "\"Running this event? Claim it\". Null unless the event was added by Blendn (curated) and nobody has claimed it. `url` is the public claim page on the dashboard host, built by the server; open it in a browser. It carries the event id and nothing about the viewer.",
      }),
    details: z
      .object({
        fullDescription: z.string(),
        houseRules: z.string().nullable(),
        cancellationPolicy: z.string().nullable(),
        additionalInfo: z.unknown().nullable(),
        faq: z.unknown().nullable(),
        accessibilityInfo: z.unknown().nullable(),
        covidGuidelines: z.string().nullable(),
      })
      .nullable(),
    categories: z.array(EventCategorySchema),
    amenities: z
      .array(
        z.object({
          id: z.string().uuid(),
          name: z.string(),
          slug: z.string(),
          subtitle: z.string().nullable(),
          icon: z.string().nullable(),
        })
      )
      .openapi({ description: "In the vocabulary's own order; do not re-sort. Detail only — the list carries none." }),
    media: z.array(
      z.object({
        id: z.string(),
        type: z.enum(["image", "video", "document"]),
        url: z.string(),
        thumbnailUrl: z.string().nullable(),
        title: z.string().nullable(),
        description: z.string().nullable(),
        order: z.number().int(),
      })
    ),
    // The row as selected, so snake_case — unlike every other key here.
    chatGroup: z
      .object({
        id: z.string().uuid(),
        name: z.string(),
        status: z.enum(["active", "archived", "locked"]),
        member_count: z.number().int(),
      })
      .nullable(),
    stats: EventStatsSchema,
    userStatus: UserStatusSchema,
    distance: z.number().nullable().openapi({
      description: "Kilometres from `lat`/`lon`. Null unless both are sent and the event has a pin.",
    }),
    interestedUsers: z.array(z.unknown()).max(0).optional().openapi({
      description: "Only with `include=interestedUsers`, and always empty: who favourited an event is not disclosed.",
    }),
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
    /**
     * Ask "why do you go out?" now, and save the answer as the default.
     *
     * True while `profiles.intent_default` is empty and nothing was chosen for
     * this event. The app sends the answer with `rememberIntent: true` on
     * `PUT /events/:eventId/matches/preferences`; after that this is false at
     * every later door.
     */
    intentNeeded: z.boolean(),
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
      // No average: a rater could subtract their own (SCRUM-437).
      ratingCount: z.number(),
    }),
    message: z.string(),
  })
  .openapi("RatingResponse")

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
        userId: RoomUserRefSchema,
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
        sharedWorkField: z
          .boolean()
          .describe(
            "Whether they work in the caller's own field. Suppressed by the SAME floor as `workField` — always false in rooms below eight people — because the caller knows their own field, so `true` would name theirs exactly and hand back through a second door the attribute the floor withholds."
          ),
        age: z
          .number()
          .int()
          .nullable()
          .describe(
            "Whole years, derived server-side from the birth date. Never a birth date. Already public via `publicProfileFields` on /profiles/{userId}, so this carries no new exposure — and unlike `workField` it is NOT suppressed in a small room, since withholding it would only make the roster disagree with the profile one tap away."
          ),
        insideNow: z.boolean(),
        /** Whether you liked them. Never whether they liked you. */
        youLiked: z.boolean(),
      })
    ),
  })
  .openapi("MatchListResponse")

export const LikeRequestSchema = z
  .object({
    userId: ThisRoomRefSchema,
    /** Like them on your crew's behalf (crew → person); see the description. */
    asCrewId: z.string().uuid().optional(),
  })
  .openapi("LikeRequest")

export const LikeResponseSchema = z
  .object({
    mutual: z.boolean().optional(),
    conversationId: z.string().optional(),
    /** With `asCrewId`: the crew like was recorded. */
    liked: z.literal(true).optional(),
    /** With `asCrewId`: the Blend it made, if they had liked your crew. */
    blend: z.object({ blendId: z.string().uuid(), chatGroupId: z.string().uuid() }).nullable().optional(),
  })
  .openapi("LikeResponse")

export const RoomPreviewResponseSchema = z
  .object({
    /** Distinct people checked in right now — the socket's `hereCount`. */
    hereCount: z.number().int(),
    /** Inside now and sharing ≥1 interest with you; null when hereCount < 3. */
    tasteMatchCount: z.number().int().nullable(),
  })
  .openapi("RoomPreviewResponse")

export const WaveRequestSchema = z
  .object({ toUserId: ThisRoomRefSchema })
  .openapi("WaveRequest")

export const WaveResponseSchema = z
  .object({ sent: z.literal(true) })
  .openapi("WaveResponse")

export const MatchPreferencesSchema = z
  .object({
    intent: z.array(z.enum(["dating", "networking", "friendship", "just_here"])).optional(),
    revealed: z.boolean().optional(),
    /** "Open to joining a crew tonight": crews are shown to you, and may like you, only with this on — until the end of the occurrence you are checked in at; `false` clears it. */
    openToCrews: z.boolean().optional(),
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
        userId: RoomUserRefSchema,
        /**
         * The room pseudonym ("Cosmic Panda"), not the real name — the same one
         * this person carries in the event chat — unless they turned on "Show
         * who I am" in this room, in which case it is their name and `image`
         * their photo. Otherwise `image` is absent: a photo identifies as
         * surely as a name.
         */
        name: z.string(),
        image: z.string().nullable().optional(),
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
    users: z.array(z.unknown()).max(0).openapi({
      description: "Always empty. Kept so a build iterating it gets zero rather than a crash.",
    }),
    interestedCount: z.number().int().openapi({ description: "How many people favourited the event." }),
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
  BatchCheckinsResponse: BatchCheckinsResponseSchema,
  BatchInterestsResponse: BatchInterestsResponseSchema,
  BatchInterestCountsResponse: BatchInterestCountsResponseSchema,
  AttendeeListResponse: AttendeeListResponseSchema,
  PeerRatingRequest: PeerRatingRequestSchema,
  RatablePeersResponse: RatablePeersResponseSchema,
  MatchListResponse: MatchListResponseSchema,
  LikeRequest: LikeRequestSchema,
  LikeResponse: LikeResponseSchema,
  RoomPreviewResponse: RoomPreviewResponseSchema,
  WaveRequest: WaveRequestSchema,
  WaveResponse: WaveResponseSchema,
  MatchPreferences: MatchPreferencesSchema,
  InterestedUsersResponse: InterestedUsersResponseSchema,
}

for (const [name, schema] of Object.entries(schemas)) {
  registry.register(name, schema)
}
