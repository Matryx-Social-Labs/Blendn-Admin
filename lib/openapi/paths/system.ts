import { z } from "zod"
import { registry } from "@/lib/openapi/registry"

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
