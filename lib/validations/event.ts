import { z } from "zod"

export const eventQuerySchema = z.object({
  // Pagination
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),

  // Search
  search: z.string().optional(),

  // Nearby filter
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
  radius: z.coerce.number().min(0.1).max(100).default(10), // km

  // Category filter
  categoryId: z.string().uuid().optional(),
  categorySlug: z.string().optional(),

  // Date filters
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),

  // Status filter
  status: z.enum(["draft", "published", "cancelled", "completed"]).optional(),

  // Sort
  sortBy: z.enum(["start_time", "created_at", "distance"]).default("start_time"),
  sortOrder: z.enum(["asc", "desc"]).default("asc"),

  // Optional includes (comma-separated list)
  include: z.string().optional(),

  // Interested preview limit (used when include contains interestedPreview)
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
