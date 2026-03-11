import { z } from "zod"
import { registry } from "@/lib/openapi/registry"
import { standardErrors } from "@/lib/openapi/schemas/common"

registry.registerPath({
  method: "get",
  path: "/api/health",
  tags: ["System"],
  summary: "Health check",
  description: "Returns service health status including database connectivity.",
  responses: {
    200: {
      description: "Service healthy",
      content: {
        "application/json": {
          schema: z.object({
            status: z.enum(["ok", "degraded"]),
            timestamp: z.string().datetime(),
            service: z.literal("blendn-admin"),
            version: z.string(),
            database: z.enum(["connected", "disconnected", "unknown"]),
          }),
        },
      },
    },
    503: {
      description: "Service degraded",
      content: {
        "application/json": {
          schema: z.object({
            status: z.literal("degraded"),
            timestamp: z.string().datetime(),
            service: z.literal("blendn-admin"),
            version: z.string(),
            database: z.literal("disconnected"),
          }),
        },
      },
    },
  },
})

// GET /api/cron/event-reminders
registry.registerPath({
  method: "get",
  path: "/api/cron/event-reminders",
  tags: ["Cron"],
  summary: "Trigger event reminder notifications",
  description: "Sends push notifications for events starting within 1 hour. Authenticated via CRON_SECRET Bearer token.",
  security: [{ BearerAuth: [] }],
  responses: {
    200: {
      description: "Reminders sent",
      content: {
        "application/json": {
          schema: z.object({
            success: z.literal(true),
            notified: z.number(),
            timestamp: z.string().datetime(),
          }),
        },
      },
    },
    ...standardErrors,
  },
})
