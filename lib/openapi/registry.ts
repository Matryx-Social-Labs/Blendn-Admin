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
        "Note: `/api/mobile/v1/*` is rewritten to `/api/mobile/*` by middleware — both URL prefixes work identically. " +
        "Bad input is a 4xx, never a 500: a path id or cursor that cannot be a row, or a body that is not JSON, answers 400 (see docs/API.md). " +
        "Every `/api/mobile` request can also be refused before its route runs: 426 `UPDATE_REQUIRED` when `X-App-Version` " +
        "is a plain version below the server's minimum (never when the header is absent, `unknown` or unparsable), and " +
        "503 `MAINTENANCE` with `retryAfter` and a `Retry-After` header during planned downtime. " +
        "A build also says which Android channel set it has with `X-Channel-Set` (`2` for Flow 9); `GET /notifications` serves a build without it the old kinds.",
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
      { name: "Mobile Venues", description: "Venue discovery (the Hotspots feed)" },
      { name: "Dashboard Events", description: "Admin event management" },
      { name: "Dashboard Chat Moderation", description: "Chat message moderation and member management" },
      { name: "Dashboard Announcements", description: "Event announcements" },
      { name: "Dashboard Sponsored Messages", description: "Recurring sponsored messages in chat" },
      { name: "Dashboard Uploads", description: "Admin file uploads" },
      { name: "Cron", description: "Scheduled tasks (internal)" },
      { name: "Public share", description: "Unauthenticated reads for the landing site's event and venue pages (server to server)" },
      { name: "System", description: "Health check" },
    ],
  })
}
