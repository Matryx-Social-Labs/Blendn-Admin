import * as z from "zod"

// ── Schema ────────────────────────────────────────────────────────────────────

export const faqItemSchema = z.object({
  question: z.string().min(1, "Question required"),
  answer: z.string().min(1, "Answer required"),
})

export const kvItemSchema = z.object({
  key: z.string().min(1, "Key required"),
  value: z.string().min(1, "Value required"),
})

export const eventFormSchema = z.object({
  title: z.string().min(3, { message: "Title must be at least 3 characters." }),
  description: z.string().min(10, { message: "Description must be at least 10 characters." }),
  full_description: z.string().min(10, { message: "Full description must be at least 10 characters." }),
  short_description: z.string().optional(),
  venue_name: z.string().optional(),
  // Set only when a listed venue is picked. Free text leaves this null, which
  // is the common case — most events are at places not on the platform.
  venue_id: z.string().nullable().optional(),
  venue_link_status: z.enum(["auto_linked", "confirmed", "disputed"]).nullable().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  postal_code: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  // 2000 matches GEOFENCE_LIMITS.MAX_RADIUS in lib/geofence.ts. It was 5000,
  // which meant anything between 2001 and 5000 passed here and was rejected by
  // the server with a bare 400 — client validation saying yes to what the
  // server says no to is worse than having no client validation.
  check_in_radius: z.number().min(10).max(2000).optional(),
  // Shape validated server-side by lib/geofence-input.ts — duplicating the
  // geometry rules here would be a second implementation to drift.
  geofence: z.any().optional(),
  start_time: z.string().min(1, { message: "Start time is required." }),
  end_time: z.string().min(1, { message: "End time is required." }),
  timezone: z.string().min(1, { message: "Timezone is required." }),
  status: z.enum(["draft", "published", "cancelled", "completed"]),
  visibility: z.enum(["public", "private", "unlisted"]),
  max_capacity: z.number().optional(),
  /** Blank for almost every event; 13–25 when it matters. See `lib/age.ts`. */
  min_age: z.number().int().min(13).max(25).optional(),
  cover_image_url: z.string().url().optional().or(z.literal("")),
  external_link: z.string().url().optional().or(z.literal("")),
  is_featured: z.boolean().optional(),
  house_rules: z.string().optional(),
  cancellation_policy: z.string().optional(),
  faq: z.array(faqItemSchema).optional(),
  additional_info: z.array(kvItemSchema).optional(),
  accessibility_info: z.array(kvItemSchema).optional(),
  category_ids: z.array(z.string()).optional(),
  primary_category_id: z.string().optional(),
  media_items: z
    .array(
      z.object({
        id: z.string(),
        type: z.enum(["image", "video", "document"]),
        url: z.string().url(),
        thumbnail_url: z.string().url().optional().or(z.literal("")),
        title: z.string().optional(),
        description: z.string().optional(),
      })
    )
    .optional(),
})

export type EventFormValues = z.infer<typeof eventFormSchema>
