import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi"
import { z } from "zod"

extendZodWithOpenApi(z)

export const registry = new OpenAPIRegistry()

// Security schemes
registry.registerComponent("securitySchemes", "BearerAuth", {
  type: "http",
  scheme: "bearer",
  bearerFormat: "JWT",
  description: "Mobile JWT access token",
})

registry.registerComponent("securitySchemes", "SessionAuth", {
  type: "apiKey",
  in: "cookie",
  name: "next-auth.session-token",
  description: "NextAuth session cookie (dashboard)",
})

export function generateOpenApiDocument() {
  const generator = new OpenApiGeneratorV31(registry.definitions)

  return generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "Blendn API",
      version: "1.0.0",
      description:
        "API for the Blendn event discovery and social platform. " +
        "Mobile endpoints use JWT Bearer authentication. " +
        "Dashboard endpoints use NextAuth session cookies. " +
        "Note: `/api/mobile/v1/*` is rewritten to `/api/mobile/*` by middleware — both URL prefixes work identically.",
    },
    servers: [{ url: "/" }],
    tags: [
      { name: "Mobile Auth", description: "Signup, signin, token management" },
      { name: "Mobile Events", description: "Event listing, search, interactions" },
      { name: "Mobile Chat", description: "Group chat operations" },
      { name: "Mobile Conversations", description: "Direct messaging" },
      { name: "Mobile Profiles", description: "User profile management" },
      { name: "Mobile Uploads", description: "File upload presigned URLs" },
      { name: "Mobile Users", description: "User operations (block, favorites)" },
      { name: "Mobile Notifications", description: "Push notification token management" },
      { name: "Mobile Message Requests", description: "Message request flow" },
      { name: "Mobile Checkins", description: "Active check-in status" },
      { name: "Mobile Categories", description: "Event categories" },
      { name: "Dashboard Events", description: "Admin event management" },
      { name: "Dashboard Uploads", description: "Admin file uploads" },
      { name: "System", description: "Health check" },
    ],
  })
}
