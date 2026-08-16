import { z } from "zod"

export const eventQuerySchema = z.object({
  // Pagination
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),

  // Search
  search: z.string().optional(),

  /**
   * Where to browse. The one thing that scopes a page of discovery.
   *
   * Matched case-insensitively against `events.city`, which the organiser no
   * longer types — it is derived from the map pin via `lib/address.ts`. Exact
   * rather than `contains`, because `search` already does fuzzy matching across
   * four columns and scoping a whole screen on "Bengaluru also matches an event
   * *titled* Bengaluru Meetup held in Delhi" is not a scope at all.
   */
  city: z.string().min(1).max(100).optional(),

  // Nearby filter
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
  /**
   * **No default, deliberately.** This used to be `.default(10)`, so every
   * request that sent coordinates — which the home screen always did — was
   * silently capped at a 10 km box around the device. Every section of that
   * screen is a `useMemo` over one such query, so one empty result blanked the
   * whole page, and the empty state told the user to "explore with location
   * enabled" when location is exactly what had emptied it.
   *
   * Distance is a sort and a label now, not a filter. This parameter survives
   * for callers that genuinely want a bounded search and must ask for it.
   */
  radius: z.coerce.number().min(0.1).max(100).optional(), // km

  // Category filter
  categoryId: z.string().uuid().optional(),
  categorySlug: z.string().optional(),

  // Date filters
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),

  /**
   * Include events that have already finished. Off by default — discovery
   * should not be a list of things you cannot go to. History screens opt in.
   */
  includePast: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .transform((v) => v === true || v === "true")
    .optional()
    .default(false),

  // Status filter
  status: z.enum(["draft", "published", "cancelled", "completed"]).optional(),

  // Sort
  sortBy: z.enum(["start_time", "created_at", "distance"]).default("start_time"),
  sortOrder: z.enum(["asc", "desc"]).default("asc"),

  // Optional includes (comma-separated list)
  include: z.string().optional(),

  /*
   * Accepted and ignored.
   *
   * `interestedPreview` is gone — it returned real photographs of everyone who
   * had favourited an event, to any authenticated caller, with no identity
   * gate. Builds in the field still send this parameter, and rejecting it would
   * turn a silent no-op into a 400 on the events list, which is the whole
   * screen. Remove once no build sends it.
   */
  interestedPreviewLimit: z.coerce.number().int().min(1).max(6).optional(),
})

export const checkinSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  deviceInfo: z
    .object({
      platform: z.string().optional(),
      device: z.string().optional(),
      appVersion: z.string().optional(),
      gpsAccuracy: z.number().optional(), // accuracy radius in metres
    })
    .optional(),
})

// Maximum acceptable GPS accuracy (metres). Submissions worse than this are rejected.
export const MAX_GPS_ACCURACY_METERS = 150

export const ratingSchema = z.object({
  rating: z.number().int().min(1).max(5),
  review: z.string().max(1000).optional(),
})

// Organiser broadcast messaging. Both of these fan out to every attendee of an
// event, so the bounds here are the only thing between a typo and a push
// notification to the whole room.
export const SPONSORED_MESSAGE_INTERVALS = [10, 15, 30, 60] as const

export const sponsoredMessageCreateSchema = z.object({
  content: z.string().trim().min(1, "content is required").max(2000),
  interval_minutes: z
    .number()
    .int()
    .refine(
      (v) => (SPONSORED_MESSAGE_INTERVALS as readonly number[]).includes(v),
      `interval_minutes must be one of ${SPONSORED_MESSAGE_INTERVALS.join(", ")}`
    ),
})

// PATCH is a partial update; every field is optional but must still be the
// right type when present. Previously `content.trim()` was called on whatever
// arrived, so PATCH {"content": 123} returned a 500.
export const sponsoredMessageUpdateSchema = sponsoredMessageCreateSchema
  .partial()
  .extend({ is_active: z.boolean().optional() })

export const announcementSchema = z.object({
  content: z.string().trim().min(1, "content is required").max(2000),
})

export type EventQueryInput = z.infer<typeof eventQuerySchema>
export type CheckinInput = z.infer<typeof checkinSchema>
export type RatingInput = z.infer<typeof ratingSchema>

/**
 * The event write body.
 *
 * `POST /api/events` and `PATCH /api/events/[id]` were the last write endpoints
 * in the codebase with no schema -- they destructured 37 fields and relied on
 * that destructure as the allow-list. That stops mass assignment, so it was not
 * an access hole, but nothing bounded a string's length or checked that
 * `latitude` was a number, and `parseJsonField` `JSON.parse`d three body fields
 * straight into Prisma Json columns with no shape or size limit at all.
 *
 * Deliberately permissive where the route already guards: `check_in_radius` and
 * `geofence` pass through to `validateLocationInput`, which bounds them
 * server-side, and capacity keeps its existing explicit check. This schema is
 * about types and lengths, not about relitigating those.
 *
 * `.partial()` covers PATCH; the POST route keeps its own required-field check.
 */
const jsonish = z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())])

export const eventWriteSchema = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().max(5000),
    short_description: z.string().max(500).nullish(),
    venue_name: z.string().max(200).nullish(),
    venue_id: z.string().uuid().nullish(),
    address: z.string().max(500).nullish(),
    city: z.string().max(100).nullish(),
    state: z.string().max(100).nullish(),
    country: z.string().max(100).nullish(),
    postal_code: z.string().max(20).nullish(),
    start_time: z.union([z.string(), z.date()]),
    end_time: z.union([z.string(), z.date()]),
    timezone: z.string().max(64).nullish(),
    status: z.enum(["draft", "published", "cancelled", "completed"]).nullish(),
    visibility: z.enum(["public", "private", "unlisted"]).nullish(),
    max_capacity: z.number().int().nullish(),
    door_policy: z.enum(["open", "guest_list", "members_only", "invite_only"]).nullish(),
    /**
     * Minimum age to check in. Null is the normal case.
     *
     * Bounded at 13 because that is the floor for holding an account at all —
     * an event demanding less is expressing a rule the platform cannot have —
     * and at 25 because beyond that it stops being a legal age restriction and
     * starts being a way to keep people out, which the organiser should do at
     * the door and own, not have the platform enforce invisibly.
     */
    min_age: z.number().int().min(13).max(25).nullish(),
    latitude: z.number().min(-90).max(90).nullish(),
    longitude: z.number().min(-180).max(180).nullish(),
    cover_image_url: z.string().url().max(2048).nullish(),
    external_link: z.string().url().max(2048).nullish(),
    is_featured: z.boolean().nullish(),
    is_recurring: z.boolean().nullish(),
    check_in_radius: z.number().nullish(),
    full_description: z.string().max(20000).nullish(),
    house_rules: z.string().max(5000).nullish(),
    cancellation_policy: z.string().max(5000).nullish(),
    // Shape-checked and size-bounded rather than free JSON. These land in Json
    // columns and were previously whatever `JSON.parse` returned.
    additional_info: jsonish.nullish(),
    faq: jsonish.nullish(),
    accessibility_info: jsonish.nullish(),
    covid_guidelines: z.string().max(5000).nullish(),
    category_ids: z.array(z.string().uuid()).max(20).nullish(),
    primary_category_id: z.string().uuid().nullish(),
    /*
     * `uuid()` matters here beyond tidiness: these ids go straight into a
     * `connect`, and a non-uuid would surface as a Prisma error rather than a
     * 400 with a field name on it. Capped at 20 for the same reason the
     * category list is — the picker is a curated vocabulary of about a dozen,
     * so anything near the cap is a client bug, not a thorough organiser.
     */
    amenity_ids: z.array(z.string().uuid()).max(20).nullish(),
    media_items: z.array(z.record(z.string(), z.unknown())).max(50).nullish(),
    geofence: z.unknown().nullish(),
  })
  .partial()
