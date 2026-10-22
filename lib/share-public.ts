import { timingSafeEqual } from "crypto"
import { isIP } from "net"
import { NextResponse, type NextRequest } from "next/server"

import { isUuid } from "@/lib/api-input"
import { clientNetworkFrom } from "@/lib/client-ip"
import { RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW } from "@/lib/constants"
import { db } from "@/lib/db"
import { hostNotSuspended } from "@/lib/event-access"
import { realEventsWhere } from "@/lib/event-kind"
import { shareProxySecret } from "@/lib/env"
import { logger } from "@/lib/logger"
import { rateLimit } from "@/lib/rate-limit"
import { publicBucketHosts } from "@/lib/tigris"
import { venueTypeLabel } from "@/lib/venue-types"
import { atTheVenue, eventArea, eventVenue, takeoverSelect } from "@/lib/venue-visibility"
import { upcomingEventsWhere } from "@/lib/venue-listing"

/**
 * The public read behind the landing site's event and venue pages and their
 * link-preview cards (Flow 16). Server to server: the landing's functions call
 * it, nobody's browser does, so there is no CORS.
 *
 * ## What it must never do
 *
 * Tell a stranger that an event exists when they may not know it does. A
 * private event, a draft, a deleted one, a suspended host's, a venue day, an
 * id that is not a UUID and an id nobody ever made all answer with the ONE
 * response below, byte for byte, headers included. Nothing here logs or varies
 * by reason, and a database failure is a different answer (503), never this
 * one, so a flaky read cannot make a real event look deleted.
 *
 * An unlisted event is readable by whoever holds its link, and shows the area
 * and nothing finer: no venue, no address, no description, no other events at
 * the venue. It is not indexable.
 */

/** What a share page may be cached for, at the edge and in the landing's own cache. Same on every answer. */
const SHARE_CACHE_CONTROL = "public, s-maxage=60, stale-while-revalidate=60"

const SHARE_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": SHARE_CACHE_CONTROL,
  "X-Content-Type-Options": "nosniff",
  // The JSON is for the landing's functions; only the pages it renders are indexed.
  "X-Robots-Tag": "noindex",
} as const

const UNAVAILABLE_BODY = JSON.stringify({ available: false })

/** How many other events a public event's page lists at its venue, and a venue's page lists of its own. */
const EVENT_VENUE_UPCOMING = 3
const VENUE_UPCOMING = 5

export const PUBLIC_COVER_FOLDER = "/events/"

/** The one answer for every reason an id is not readable. A fresh response each time, the same bytes. */
export function unavailableResponse(): NextResponse {
  return new NextResponse(UNAVAILABLE_BODY, { status: 404, headers: SHARE_HEADERS })
}

/** A read that failed on our side. Never cached, never indexed, and never mistaken for "unavailable". */
export function tryAgainResponse(): NextResponse {
  return new NextResponse(JSON.stringify({ available: false, retry: true }), {
    status: 503,
    headers: { ...SHARE_HEADERS, "Cache-Control": "no-store", "Retry-After": "5" },
  })
}

function availableResponse(body: unknown): NextResponse {
  return new NextResponse(JSON.stringify(body), { status: 200, headers: SHARE_HEADERS })
}

// ── Who is asking ───────────────────────────────────────

function secretMatches(given: string | null): boolean {
  const configured = shareProxySecret()
  if (!configured || !given) return false
  const want = Buffer.from(configured)
  const have = Buffer.from(given)
  // Length first: timingSafeEqual throws on a mismatch, and the length is not the secret.
  return have.length === want.length && timingSafeEqual(have, want)
}

/**
 * The network this request is limited as: the visitor the landing forwards in
 * `x-share-client`, but only from a caller that proved it is the landing with
 * `x-share-proxy`. Anyone else's header is ignored, so a forged one buys
 * neither a fresh bucket nor somebody else's, and they are limited by their
 * own address. A forwarded value that is not an IP is ignored the same way.
 */
export function shareNetworkFor(headers: { get(name: string): string | null }): string {
  const forwarded = headers.get("x-share-client")?.trim() ?? ""
  if (secretMatches(headers.get("x-share-proxy")) && isIP(forwarded) !== 0) {
    return clientNetworkFrom({ get: (name) => (name === "x-real-ip" ? forwarded : null) })
  }
  return clientNetworkFrom(headers)
}

/**
 * 120 a minute per network, under ONE fixed key. `rateLimit`'s default key
 * includes the path, which would give a scraper a fresh bucket per event id.
 * A refusal is never cached: a cached 429 would refuse the next visitor.
 */
export async function shareRateLimit(req: NextRequest): Promise<NextResponse | null> {
  const limited = await rateLimit(req, {
    windowMs: RATE_LIMIT_WINDOW.SHARE_PUBLIC,
    maxRequests: RATE_LIMIT_MAX_REQUESTS.SHARE_PUBLIC,
    keyGenerator: () => `share:${shareNetworkFor(req.headers)}`,
  })
  if (limited) limited.headers.set("Cache-Control", "no-store")
  return limited
}

// ── What it says ────────────────────────────────────────

export type ShareState = "upcoming" | "cancelled" | "ended"

/** Cancelled is cancelled; otherwise an event that is over (completed, or its end has passed) is ended. */
export function shareState(status: "published" | "cancelled" | "completed" | string, endTime: Date, now: Date): ShareState {
  if (status === "cancelled") return "cancelled"
  return status === "completed" || endTime.getTime() <= now.getTime() ? "ended" : "upcoming"
}

/**
 * A cover the landing may fetch: https on the public bucket's own host, under
 * `events/`, and nothing else. `cover_image_url` accepts any URL, and the
 * landing fetches what this returns, so anything off the bucket is dropped
 * here and checked again there. Reduced to origin and path: a query string or
 * fragment is not part of an object.
 */
export function publicCoverUrl(raw: string | null | undefined, hosts: readonly string[] = publicBucketHosts()): string | null {
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null
  // An encoded slash or backslash is a path separator to some servers and a character to others.
  if (/%2f|%5c/i.test(url.pathname)) return null
  if (!hosts.includes(url.hostname)) return null
  // `new URL` has already resolved `..` and `%2e%2e`, so a prefix test is the whole check.
  if (!url.pathname.startsWith(PUBLIC_COVER_FOLDER) || url.pathname.length === PUBLIC_COVER_FOLDER.length) return null
  return `${url.origin}${url.pathname}`
}

interface ShareEventRow {
  id: string
  title: string
  description: string
  start_time: Date
  end_time: Date
  timezone: string
  status: string
  visibility: "public" | "unlisted" | "private"
  min_age: number | null
  venue_name: string | null
  address: string | null
  city: string | null
  cover_image_url: string | null
  venue_link_status: "auto_linked" | "confirmed" | "disputed" | null
  geofence: unknown
  latitude: number | null
  longitude: number | null
  venue: { id: string; name: string; status: "active" | "archived"; deleted_at: Date | null; geofence: unknown; area: string | null } | null
}

/** The page's body for an event row, and what an unlisted one is not allowed to say. Pure. */
export function shareEventBody(
  row: ShareEventRow,
  venueUpcoming: { id: string; title: string; start_time: Date; end_time: Date; timezone: string }[],
  now: Date
) {
  const unlisted = row.visibility === "unlisted"
  const venue = eventVenue(row)
  return {
    available: true as const,
    event: {
      id: row.id,
      title: row.title,
      description: unlisted ? null : row.description,
      startsAt: row.start_time,
      endsAt: row.end_time,
      timezone: row.timezone,
      state: shareState(row.status, row.end_time, now),
      // Ended public events stay indexable (owner, 2026-10-22); an unlisted one is for people holding the link.
      indexable: !unlisted,
      minAge: row.min_age,
      place: unlisted
        ? { venue: null, name: null, address: null, area: eventArea(row, row.city) }
        : { venue, name: row.venue_name, address: row.address, area: eventArea(row, row.city) },
      // Never for an unlisted event: the key is chosen by the uploader and can carry any text (a venue's name).
      coverUrl: unlisted ? null : publicCoverUrl(row.cover_image_url),
      venueUpcoming: unlisted
        ? []
        : venueUpcoming.map((e) => ({ id: e.id, title: e.title, startsAt: e.start_time, endsAt: e.end_time, timezone: e.timezone })),
    },
  }
}

const upcomingSelect = { id: true, title: true, start_time: true, end_time: true, timezone: true } as const

/** A host who is a person, and neither suspended nor gone. The org half is `hostNotSuspended`. */
const hostPersonActive = { organizer: { suspended_at: null, deletedAt: null } }

/** How many candidates are read per event shown, because `atTheVenue` is judged in code and drops some. */
const AT_VENUE_OVERFETCH = 4

/**
 * The next public events at a venue, for a page that names it. Never an
 * unlisted, private, draft or suspended host's, and only events actually AT
 * the venue (`atTheVenue`: a confirmed link, or the event's own area at the
 * venue): any organiser can link any venue, and a stranger's event elsewhere
 * must not appear on its page.
 */
async function upcomingAt(venueId: string, venueGeofence: unknown, now: Date, take: number, exceptEventId?: string) {
  const candidates = await db.events.findMany({
    where: {
      AND: [
        upcomingEventsWhere(null, now),
        hostNotSuspended,
        hostPersonActive,
        { venue_id: venueId, ...(exceptEventId ? { id: { not: exceptEventId } } : {}) },
      ],
      ...realEventsWhere,
    },
    orderBy: [{ start_time: "asc" }, { id: "asc" }],
    take: take * AT_VENUE_OVERFETCH,
    select: { ...upcomingSelect, ...takeoverSelect },
  })
  return candidates.filter((e) => atTheVenue(e, venueGeofence)).slice(0, take)
}

/** Null is "unavailable", whatever the reason. A throw is a failed read and is the caller's 503. */
export async function readShareEvent(eventId: string, now: Date = new Date()) {
  if (!isUuid(eventId)) return null
  const row = await db.events.findFirst({
    where: {
      id: eventId,
      deleted_at: null,
      ...realEventsWhere,
      status: { in: ["published", "cancelled", "completed"] },
      visibility: { in: ["public", "unlisted"] },
      AND: [hostNotSuspended, hostPersonActive],
    },
    select: {
      id: true,
      title: true,
      description: true,
      start_time: true,
      end_time: true,
      timezone: true,
      status: true,
      visibility: true,
      min_age: true,
      venue_name: true,
      address: true,
      city: true,
      cover_image_url: true,
      venue_link_status: true,
      geofence: true,
      latitude: true,
      longitude: true,
      venue: { select: { id: true, name: true, status: true, deleted_at: true, geofence: true, area: true } },
    },
  })
  if (!row) return null

  // Only a venue the event is confirmed at, and only for a public event: an unlisted page names no place.
  const venue = row.visibility === "public" ? eventVenue(row) : null
  const upcoming = venue ? await upcomingAt(venue.id, row.venue?.geofence, now, EVENT_VENUE_UPCOMING, row.id) : []
  return shareEventBody(row, upcoming, now)
}

/** The page's body for a venue. `indexable` is false for a claimed venue its owner took off Blendn. */
export async function readShareVenue(venueId: string, now: Date = new Date()) {
  if (!isUuid(venueId)) return null
  const venue = await db.venues.findFirst({
    where: { id: venueId, deleted_at: null, status: "active" },
    select: { id: true, name: true, venue_type: true, area: true, address: true, city: true, owner_org_id: true, open_on_blendn: true, geofence: true },
  })
  if (!venue) return null
  const upcoming = await upcomingAt(venue.id, venue.geofence, now, VENUE_UPCOMING)
  // Claimed, and its owner turned Open on Blendn off (`openOnBlendnWhere`'s other half).
  const takenOffBlendn = venue.owner_org_id !== null && !venue.open_on_blendn
  return {
    available: true as const,
    venue: {
      id: venue.id,
      name: venue.name,
      typeLabel: venue.venue_type ? venueTypeLabel(venue.venue_type) : null,
      area: venue.area,
      address: venue.address,
      city: venue.city,
      indexable: !takenOffBlendn,
      upcoming: upcoming.map((e) => ({ id: e.id, title: e.title, startsAt: e.start_time, endsAt: e.end_time, timezone: e.timezone })),
    },
  }
}

/** One handler for both routes: limit, read, answer. Anything that throws is a 503, never "unavailable". */
export async function serveShare(
  req: NextRequest,
  id: string,
  read: (id: string) => Promise<object | null>
): Promise<NextResponse> {
  const limited = await shareRateLimit(req)
  if (limited) return limited
  try {
    const body = await read(id)
    return body ? availableResponse(body) : unavailableResponse()
  } catch (error) {
    logger.error("Share read failed", { error: error instanceof Error ? error.message : String(error) })
    return tryAgainResponse()
  }
}
