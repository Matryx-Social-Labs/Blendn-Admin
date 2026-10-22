import { NextRequest } from "next/server"

import { ageFrom } from "@/lib/age"
import { isUuid } from "@/lib/api-input"
import { notFoundResponse, serverErrorResponse, successResponse, unauthorizedResponse } from "@/lib/api-response"
import { personAtTheDoor } from "@/lib/check-in-core"
import { db } from "@/lib/db"
import { dashboardUrl } from "@/lib/email"
import { realEventsWhere, venueDaysWhere } from "@/lib/event-kind"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { liveGuestIds, venueLiveBucket } from "@/lib/live-count"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { venueDayAt, venueDayBounds } from "@/lib/venue-day"
import { venueTypeLabel } from "@/lib/venue-types"
import { venueHours } from "@/lib/venue-hours"
import { eventTakingOver, goLiveArea, mayAttendWhere, undisputedLinkWhere } from "@/lib/venue-visibility"

export const dynamic = "force-dynamic"

/** How many of the venue's coming events the page lists. */
const UPCOMING_LIMIT = 5

interface RouteParams {
  params: Promise<{ venueId: string }>
}

/**
 * One venue, as the Go Live screen needs it (docs/API.md, `GET /venues/:id`).
 *
 * - `live.open`: whether going live here would be accepted now, and if not,
 *   why — a real event has the venue (`event_live_here`, with its id) or the
 *   venue has no check-in area (`no_check_in_area`). The area itself is never
 *   returned: no payload draws the boundary (plan v2 §4, SEC-19).
 * - `live.liveNow`: how many guests are live here, as a bucket and never a
 *   number (D-19, D-x2, F14): steady for a minute, slow to fall, and never
 *   counting the caller (`lib/live-count.ts`). An exact count that moves from
 *   4 to 5 tells a watcher that one person just walked in.
 * - `live.youAreLive` / `expiresAt` / `venueDayId` / `chatGroupId`: the
 *   caller's own window, so the app counts down from the server's `expiresAt`
 *   rather than from a tap, and opens the room by id.
 * - `venue.upcoming`: its next public events (age-filtered for you; a link its
 *   owner disputed, and the venue's own live rooms, are not events here), at most
 *   `UPCOMING_LIMIT`. `hours` / `description` / `amenities` are null / [] until given.
 * - `tonight`: the next real event here before the venue's day resets.
 * - `claim`: the public claim page for an unclaimed venue, on the dashboard
 *   host (`/claim/venue/[venueId]`), as `GET /events/:id` offers an event's:
 *   the app opens it as given and hard-codes no environment.
 *
 * The people live here are not on this payload. They are the venue day's
 * roster and grid, which only somebody live here may read (reciprocity,
 * `inRoomWhere`).
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { venueId } = await params
    if (!isUuid(venueId)) return notFoundResponse("Venue not found")

    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const userId = authUser.userId

    // Polling this for a change is the attack on the count; a phone needs
    // a refresh every half minute.
    const limited = await rateLimit(request, userLimit("read", "venue-detail", userId))
    if (limited) return limited

    const venue = await db.venues.findFirst({
      where: { id: venueId, deleted_at: null, status: "active" },
      select: {
        id: true,
        name: true,
        address: true,
        city: true,
        latitude: true,
        longitude: true,
        venue_type: true,
        floors: true,
        owner_org_id: true,
        geofence: true,
        timezone: true,
        day_reset_hour: true,
        capacity: true,
        hours: true,
        description: true,
        amenity_links: {
          where: { amenity: { is_active: true } },
          orderBy: [{ amenity: { sort_order: "asc" } }, { amenity_id: "asc" }],
          select: { amenity: { select: { name: true } } },
        },
      },
    })
    if (!venue) return notFoundResponse("Venue not found")

    // A live room is somewhere to take part; the same 18+ gate as its door.
    const person = await personAtTheDoor(userId, null)
    if ("refusal" in person) return person.refusal

    const now = new Date()
    const viewerAge = ageFrom(person.profile)
    const dayEnd = venueDayBounds(venue.timezone, venue.day_reset_hour, now).end

    const [takeover, tonight, mine, today, upcoming] = await Promise.all([
      eventTakingOver(venueId, now, { viewerAge }),
      eventTakingOver(venueId, now, { viewerAge, leadMinutes: (dayEnd.getTime() - now.getTime()) / 60_000 }),
      db.event_check_ins.findFirst({
        where: { status: "checked_in", expires_at: { gt: now }, event: { ...venueDaysWhere, venue_id: venueId }, user_id: userId },
        select: { event_id: true, expires_at: true, stay: true, stay_until: true, kind: true },
      }),
      venueDayAt(venueId, now),
      db.events.findMany({
        where: {
          venue_id: venueId,
          deleted_at: null,
          // Never the venue's own live rooms (F3): they are not events at it.
          ...realEventsWhere,
          // The Places card's filter (`GET /venues`), so the page and the card agree on what is coming.
          status: "published",
          visibility: "public",
          end_time: { gte: now },
          AND: [undisputedLinkWhere, ...(typeof viewerAge === "number" ? [mayAttendWhere(viewerAge)] : [])],
        },
        orderBy: [{ start_time: "asc" }, { id: "asc" }],
        take: UPCOMING_LIMIT,
        select: { id: true, title: true, slug: true, cover_image_url: true, start_time: true, end_time: true },
      }),
    ])
    const [room, tonightRow] = await Promise.all([
      mine ? db.chat_groups.findUnique({ where: { event_id: mine.event_id }, select: { id: true } }) : null,
      tonight
        ? db.events.findUnique({
            where: { id: tonight.id },
            select: { id: true, title: true, slug: true, cover_image_url: true, start_time: true, end_time: true },
          })
        : null,
    ])
    // The same count as the Places list (`liveGuestIds`): distinct guests, the caller out only if counted.
    const liveNow = await venueLiveBucket(venueId, userId, async () => (await liveGuestIds([venueId], now)).get(venueId) ?? new Set())

    // The area Go Live would judge you against now — the same one (`goLiveArea`).
    const hasArea = goLiveArea(today, venue) !== null
    const closedReason = takeover ? "event_live_here" : hasArea ? null : "no_check_in_area"
    // Whether "Own this place? Claim it" applies.
    const claimed = venue.owner_org_id !== null

    return successResponse({
      venue: {
        id: venue.id,
        name: venue.name,
        address: venue.address,
        city: venue.city,
        latitude: venue.latitude,
        longitude: venue.longitude,
        venueType: venue.venue_type,
        venueTypeLabel: venueTypeLabel(venue.venue_type),
        // The 3D map's height override: floors × 3.2 m (lib/venue-floors.ts). Null: the map's own.
        floors: venue.floors,
        claimed,
        capacity: venue.capacity,
        dayResetHour: venue.day_reset_hour,
        hours: venueHours(venue.hours),
        description: venue.description,
        amenities: venue.amenity_links.map((l) => l.amenity.name),
        upcoming: upcoming.map((e) => ({
          id: e.id,
          title: e.title,
          slug: e.slug,
          coverImageUrl: e.cover_image_url,
          startTime: e.start_time,
          endTime: e.end_time,
        })),
      },
      live: {
        open: closedReason === null,
        closedReason,
        eventId: takeover?.id ?? null,
        liveNow,
        youAreLive: mine !== null,
        expiresAt: mine?.expires_at?.toISOString() ?? null,
        stay: mine?.stay ?? false,
        // The furthest a stay can carry the window (four hours from the first stay today); null until "stay" was chosen.
        stayUntil: mine?.stay_until?.toISOString() ?? null,
        venueDayId: mine?.event_id ?? null,
        chatGroupId: room?.id ?? null,
      },
      claim: claimed ? null : { url: `${dashboardUrl()}/claim/venue/${venue.id}` },
      tonight: tonightRow
        ? {
            id: tonightRow.id,
            title: tonightRow.title,
            slug: tonightRow.slug,
            coverImageUrl: tonightRow.cover_image_url,
            startTime: tonightRow.start_time,
            endTime: tonightRow.end_time,
          }
        : null,
    })
  } catch (error) {
    logger.error("Venue detail error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to load the venue")
  }
}
