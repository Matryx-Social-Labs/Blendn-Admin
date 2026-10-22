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

/*
 * GET /api/public/share/events/{eventId} and /venues/{venueId} (Flow 16)
 *
 * What the landing site's public pages and link-preview cards are drawn from.
 * Server to server; no auth, no CORS. Not for the app.
 */
const ShareHeaders = z.object({
  "x-share-proxy": z.string().optional().openapi({
    description:
      "The landing's shared secret (`SHARE_PROXY_SECRET`). Only a caller that sends it is believed about `x-share-client`; without it the caller is limited by its own address.",
  }),
  "x-share-client": z.string().optional().openapi({
    description: "The visitor's IP, forwarded by the landing. Ignored unless `x-share-proxy` matches, and ignored if it is not an IP.",
  }),
})

const ShareUpcoming = z.object({
  id: z.string().uuid(),
  title: z.string(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  timezone: z.string(),
})

const ShareUnavailable = z.object({ available: z.literal(false) }).openapi({
  description:
    "One byte-identical body, with the same headers as a 200, for every reason: private, draft, deleted, suspended host, venue day, unknown and malformed ids.",
})

const shareErrors = {
  429: { description: "Over 120 a minute for this network (key `share:<network>`). `Cache-Control: no-store`." },
  503: {
    description:
      "The read failed on our side: `{ available: false, retry: true }`, `Cache-Control: no-store`. Never cached and never the 404: try again.",
  },
} as const

registry.registerPath({
  method: "get",
  path: "/api/public/share/events/{eventId}",
  tags: ["Public share"],
  summary: "A public or unlisted event, for the landing's page and card",
  description:
    "Published, cancelled or completed events whose visibility is `public` or `unlisted` and whose host is not suspended. " +
    "An unlisted event carries only `place.area`: no venue, address or description, and an empty `venueUpcoming`; `indexable` is false. " +
    "`coverUrl` is only ever an object under `events/` on the public bucket, else null. `Cache-Control: public, s-maxage=60, stale-while-revalidate=60`.",
  request: {
    params: z.object({ eventId: z.string() }),
    headers: ShareHeaders,
  },
  responses: {
    200: {
      description: "The event",
      content: {
        "application/json": {
          schema: z.object({
            available: z.literal(true),
            event: z.object({
              id: z.string().uuid(),
              title: z.string(),
              description: z.string().nullable(),
              startsAt: z.string().datetime(),
              endsAt: z.string().datetime(),
              timezone: z.string(),
              state: z.enum(["upcoming", "cancelled", "ended"]),
              indexable: z.boolean(),
              minAge: z.number().int().nullable(),
              place: z.object({
                venue: z.object({ id: z.string().uuid(), name: z.string() }).nullable(),
                name: z.string().nullable(),
                address: z.string().nullable(),
                area: z.string().nullable(),
              }),
              coverUrl: z.string().url().nullable(),
              venueUpcoming: z.array(ShareUpcoming).max(3),
            }),
          }),
        },
      },
    },
    404: { description: "Unavailable", content: { "application/json": { schema: ShareUnavailable } } },
    ...shareErrors,
  },
})

registry.registerPath({
  method: "get",
  path: "/api/public/share/venues/{venueId}",
  tags: ["Public share"],
  summary: "A venue, for the landing's page and card",
  description:
    "An active venue. `upcoming` holds public, published, future events only (at most 5), never unlisted or private ones. " +
    "`indexable` is false for a claimed venue whose owner turned off Open on Blendn; the page still answers.",
  request: {
    params: z.object({ venueId: z.string() }),
    headers: ShareHeaders,
  },
  responses: {
    200: {
      description: "The venue",
      content: {
        "application/json": {
          schema: z.object({
            available: z.literal(true),
            venue: z.object({
              id: z.string().uuid(),
              name: z.string(),
              typeLabel: z.string().nullable(),
              area: z.string().nullable(),
              address: z.string().nullable(),
              city: z.string().nullable(),
              indexable: z.boolean(),
              upcoming: z.array(ShareUpcoming).max(5),
            }),
          }),
        },
      },
    },
    404: { description: "Unavailable", content: { "application/json": { schema: ShareUnavailable } } },
    ...shareErrors,
  },
})
