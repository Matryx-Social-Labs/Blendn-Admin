import { z } from "zod"
import { registry } from "@/lib/openapi/registry"
import { standardErrors } from "@/lib/openapi/schemas/common"
import { PresignedUrlRequestSchema, PresignedUrlResponseSchema } from "@/lib/openapi/schemas/profile"

const sessionAuth = [{ SessionAuth: [] }]
const wrap = (schema: z.ZodTypeAny) => z.object({ success: z.literal(true), data: schema })

// GET /api/events
registry.registerPath({
  method: "get",
  path: "/api/events",
  tags: ["Dashboard Events"],
  summary: "List all events (dashboard)",
  description: "Returns events for the authenticated dashboard user. Admin sees all, organizers see their own.",
  security: sessionAuth,
  responses: {
    200: { description: "Events", content: { "application/json": { schema: wrap(z.array(z.unknown())) } } },
    ...standardErrors,
  },
})

// POST /api/events
registry.registerPath({
  method: "post",
  path: "/api/events",
  tags: ["Dashboard Events"],
  summary: "Create event (dashboard)",
  security: sessionAuth,
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            title: z.string(),
            description: z.string().optional(),
            shortDescription: z.string().optional(),
            startTime: z.string().datetime(),
            endTime: z.string().datetime(),
            timezone: z.string().optional(),
            venueName: z.string().optional(),
            address: z.string().optional(),
            city: z.string().optional(),
            state: z.string().optional(),
            country: z.string().optional(),
            latitude: z.number().optional(),
            longitude: z.number().optional(),
            maxCapacity: z.number().optional(),
            checkInRadius: z.number().optional(),
            visibility: z.string().optional(),
            categoryIds: z.array(z.string().uuid()).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Created event", content: { "application/json": { schema: wrap(z.unknown()) } } },
    ...standardErrors,
  },
})

// POST /api/uploads/presigned-url
registry.registerPath({
  method: "post",
  path: "/api/uploads/presigned-url",
  tags: ["Dashboard Uploads"],
  summary: "Get presigned upload URL (dashboard)",
  description: "Presigned URL for dashboard file uploads. Requires admin/organizer/venue_owner role.",
  security: sessionAuth,
  request: {
    body: {
      content: {
        "application/json": {
          schema: PresignedUrlRequestSchema.extend({
            folder: z.enum(["profile", "chat", "events"]).default("events"),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Presigned URL", content: { "application/json": { schema: wrap(PresignedUrlResponseSchema) } } },
    ...standardErrors,
  },
})
