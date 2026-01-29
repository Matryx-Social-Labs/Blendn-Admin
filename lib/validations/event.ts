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
})

export const checkinSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  deviceInfo: z
    .object({
      platform: z.string().optional(),
      device: z.string().optional(),
      appVersion: z.string().optional(),
    })
    .optional(),
})

export const ratingSchema = z.object({
  rating: z.number().int().min(1).max(5),
  review: z.string().max(1000).optional(),
})

export type EventQueryInput = z.infer<typeof eventQuerySchema>
export type CheckinInput = z.infer<typeof checkinSchema>
export type RatingInput = z.infer<typeof ratingSchema>
