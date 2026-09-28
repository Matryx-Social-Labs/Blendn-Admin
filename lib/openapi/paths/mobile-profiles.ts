import { z } from "zod"
import { registry } from "@/lib/openapi/registry"
import { standardErrors, PaginationMetaSchema, UserRefParamSchema } from "@/lib/openapi/schemas/common"
import {
  UpdateProfileRequestSchema,
  InterestCategoryIdsSchema,
  ProfileResponseSchema,
  InterestsResponseSchema,
} from "@/lib/openapi/schemas/profile"
import { EventSessionSchema } from "@/lib/openapi/schemas/event"

const bearerAuth = [{ BearerAuth: [] }]
const wrap = (schema: z.ZodTypeAny) => z.object({ success: z.literal(true), data: schema })

// GET /api/mobile/profiles/{userId}
registry.registerPath({
  method: "get",
  path: "/api/mobile/profiles/{userId}",
  tags: ["Mobile Profiles"],
  summary: "Get user profile",
  description:
    "`userId` may be a room handle (SCRUM-371). `id` and `profile.id` echo it as sent — `profiles.id` is the user id, so both are echoed — except on your own profile.",
  security: bearerAuth,
  request: { params: z.object({ userId: UserRefParamSchema }) },
  responses: {
    200: { description: "Profile", content: { "application/json": { schema: wrap(ProfileResponseSchema) } } },
    ...standardErrors,
  },
})

// PUT /api/mobile/profiles/{userId}
registry.registerPath({
  method: "put",
  path: "/api/mobile/profiles/{userId}",
  tags: ["Mobile Profiles"],
  summary: "Update own profile",
  description:
    "Dating is 18+: for a profile under 18 (or with no age), a dating `intent_default` or a `looking_for` " +
    "containing \"dating\" (any case) is refused with 403 \"Dating is for 18+ only. Your other choices are fine.\", " +
    "and `orientations`, `interested_in` or `show_orientation: true` with 403 \"Orientation and who you're " +
    "interested in are for 18+ only.\" A new `age` or `dateOfBirth` under 18 is 400 (Blend'n is 18+, " +
    "SCRUM-330); clearing the age to unknown clears the stored dating intent, the \"dating\" in `looking_for`, " +
    "and the orientation fields. `onboarded: true` on a profile not yet onboarded is 403 \"Blend'n is for " +
    "people 18 and over. Add your date of birth to finish.\" unless the age after the request is 18+.",
  security: bearerAuth,
  request: {
    params: z.object({ userId: z.string().uuid() }),
    body: { content: { "application/json": { schema: UpdateProfileRequestSchema } } },
  },
  responses: {
    200: { description: "Updated profile", content: { "application/json": { schema: wrap(ProfileResponseSchema) } } },
    ...standardErrors,
  },
})

// GET /api/mobile/profiles/{userId}/interests
registry.registerPath({
  method: "get",
  path: "/api/mobile/profiles/{userId}/interests",
  tags: ["Mobile Profiles"],
  summary: "Get user interests",
  description:
    "A block, either way, answers **404** — the same as the profile itself (SCRUM-299). `userId` may be a room handle (SCRUM-371).",
  security: bearerAuth,
  request: { params: z.object({ userId: UserRefParamSchema }) },
  responses: {
    ...standardErrors,
    200: { description: "Interests", content: { "application/json": { schema: wrap(InterestsResponseSchema) } } },
    404: { description: "No such user, or a block between you" },
  },
})

// POST /api/mobile/profiles/{userId}/interests
registry.registerPath({
  method: "post",
  path: "/api/mobile/profiles/{userId}/interests",
  tags: ["Mobile Profiles"],
  summary: "Add interests",
  security: bearerAuth,
  request: {
    params: z.object({ userId: z.string().uuid() }),
    body: { content: { "application/json": { schema: InterestCategoryIdsSchema } } },
  },
  responses: {
    200: { description: "Updated interests", content: { "application/json": { schema: wrap(InterestsResponseSchema) } } },
    ...standardErrors,
  },
})

// DELETE /api/mobile/profiles/{userId}/interests
registry.registerPath({
  method: "delete",
  path: "/api/mobile/profiles/{userId}/interests",
  tags: ["Mobile Profiles"],
  summary: "Remove interests",
  security: bearerAuth,
  request: {
    params: z.object({ userId: z.string().uuid() }),
    body: { content: { "application/json": { schema: InterestCategoryIdsSchema } } },
  },
  responses: {
    200: { description: "Updated interests", content: { "application/json": { schema: wrap(InterestsResponseSchema) } } },
    ...standardErrors,
  },
})

/*
 * GET /api/mobile/me/attendance
 *
 * `/me`, not `/users/{userId}/attendance`, and the shape is the point: a
 * person's attendance history is where they were on which nights, which is the
 * correlation the pseudonym design exists to prevent being assembled. Scoping
 * it to the caller by construction means there is no id to get wrong and no
 * future change that widens it by accident.
 */
registry.registerPath({
  method: "get",
  path: "/api/mobile/me/attendance",
  tags: ["Mobile Profiles"],
  summary: "The events the authenticated user has attended",
  description:
    "One entry per event, however many days of it they turned up for, most recently attended " +
    "first. `attendedAt` is the first check-in for that event. `pagination.totalCount` is the " +
    "same figure shown as `stats.eventsAttended` on a profile — the two share one predicate so " +
    "the list and the number cannot disagree. Working an event as staff is not attending it.",
  security: bearerAuth,
  request: {
    query: z.object({
      page: z.coerce.number().int().min(1).optional(),
      limit: z.coerce.number().int().min(1).optional(),
    }),
  },
  responses: {
    200: {
      description: "Attended events",
      content: {
        "application/json": {
          schema: wrap(
            z.object({
              events: z.array(
                z.object({
                  id: z.string().uuid(),
                  slug: z.string(),
                  title: z.string(),
                  cover_image_url: z.string().nullable(),
                  start_time: z.string().datetime(),
                  end_time: z.string().datetime(),
                  venue_name: z.string().nullable(),
                  city: z.string().nullable(),
                  attendedAt: z.string().datetime(),
                })
              ),
              pagination: PaginationMetaSchema,
            })
          ),
        },
      },
    },
    ...standardErrors,
  },
})

/*
 * GET /api/mobile/me/rsvps
 *
 * `/me` for the same reason as attendance, in the future tense: where somebody
 * is going, and when, is the correlation the pseudonym design exists to keep
 * from being assembled.
 */
registry.registerPath({
  method: "get",
  path: "/api/mobile/me/rsvps",
  tags: ["Mobile Profiles"],
  summary: "The events the authenticated user is going to or waitlisted for",
  description:
    "RSVPs with status `going` or `waitlisted` for events that have not ended, soonest first. " +
    "Cancelled events are included with their status so the cancellation is seen; drafts and " +
    "deleted events are not. Event fields use the favourites route's names, plus `rsvpStatus` " +
    "and `rsvpAt` (when the RSVP was made).",
  security: bearerAuth,
  request: {
    query: z.object({
      page: z.coerce.number().int().min(1).optional(),
      limit: z.coerce.number().int().min(1).optional(),
    }),
  },
  responses: {
    200: {
      description: "Upcoming RSVPs",
      content: {
        "application/json": {
          schema: wrap(
            z.object({
              events: z.array(
                z.object({
                  id: z.string().uuid(),
                  slug: z.string(),
                  title: z.string(),
                  coverImageUrl: z.string().nullable(),
                  coverImage: z.record(z.string(), z.unknown()).nullable(),
                  startTime: z.string().datetime(),
                  endTime: z.string().datetime(),
                  session: EventSessionSchema,
                  timezone: z.string(),
                  status: z.enum(["published", "cancelled", "completed"]),
                  venueName: z.string().nullable(),
                  address: z.string().nullable(),
                  city: z.string().nullable(),
                  latitude: z.number().nullable(),
                  longitude: z.number().nullable(),
                  rsvpStatus: z.enum(["going", "waitlisted"]),
                  rsvpAt: z.string().datetime(),
                })
              ),
              pagination: PaginationMetaSchema,
            })
          ),
        },
      },
    },
    ...standardErrors,
  },
})
