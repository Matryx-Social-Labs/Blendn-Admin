import { z } from "zod"
import { registry } from "@/lib/openapi/registry"
import { standardErrors, PaginationMetaSchema } from "@/lib/openapi/schemas/common"
import {
  UpdateProfileRequestSchema,
  InterestCategoryIdsSchema,
  ProfileResponseSchema,
  InterestsResponseSchema,
} from "@/lib/openapi/schemas/profile"

const bearerAuth = [{ BearerAuth: [] }]
const wrap = (schema: z.ZodTypeAny) => z.object({ success: z.literal(true), data: schema })

// GET /api/mobile/profiles/{userId}
registry.registerPath({
  method: "get",
  path: "/api/mobile/profiles/{userId}",
  tags: ["Mobile Profiles"],
  summary: "Get user profile",
  security: bearerAuth,
  request: { params: z.object({ userId: z.string().uuid() }) },
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
  security: bearerAuth,
  request: { params: z.object({ userId: z.string().uuid() }) },
  responses: {
    200: { description: "Interests", content: { "application/json": { schema: wrap(InterestsResponseSchema) } } },
    ...standardErrors,
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
