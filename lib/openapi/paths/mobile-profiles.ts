import { z } from "zod"
import { registry } from "@/lib/openapi/registry"
import { standardErrors } from "@/lib/openapi/schemas/common"
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
