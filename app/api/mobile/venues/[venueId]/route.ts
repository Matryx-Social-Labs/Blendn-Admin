import { NextRequest } from "next/server"

import { ageFrom } from "@/lib/age"
import { isUuid } from "@/lib/api-input"
import { notFoundResponse, serverErrorResponse, successResponse, unauthorizedResponse } from "@/lib/api-response"
import { personAtTheDoor } from "@/lib/check-in-core"
import { db } from "@/lib/db"
import { liveCountBucket } from "@/lib/disclosure"
import { venueDaysWhere } from "@/lib/event-kind"
import { validateGeofence } from "@/lib/geofence"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { venueDayBounds } from "@/lib/venue-day"
import { venueTypeLabel } from "@/lib/venue-types"
import { venueTakeoverWhere } from "@/lib/venue-visibility"

export const dynamic = "force-dynamic"

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
 * - `live.liveNow`: how many are live here, as a bucket and never a number
 *   (D-19, F14). An exact count that moves from 4 to 5 tells a watcher that
 *   one person just walked in; a bucket moves only at its edges.
 * - `live.youAreLive` / `expiresAt` / `venueDayId` / `chatGroupId`: the
 *   caller's own window, so the app counts down from the server's `expiresAt`
 *   rather than from a tap, and opens the room by id.
 * - `tonight`: the next real event here before the venue's day resets.
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
        owner_org_id: true,
        geofence: true,
        timezone: true,
        day_reset_hour: true,
      },
    })
    if (!venue) return notFoundResponse("Venue not found")

    // A live room is somewhere to take part; the same 18+ gate as its door.
    const person = await personAtTheDoor(userId, null)
    if ("refusal" in person) return person.refusal

    const now = new Date()
    const viewerAge = ageFrom(person.profile)
    const dayEnd = venueDayBounds(venue.timezone, venue.day_reset_hour, now).end
    const liveHere = { status: "checked_in" as const, expires_at: { gt: now }, event: { ...venueDaysWhere, venue_id: venueId } }

    const [takeover, tonight, liveCount, mine] = await Promise.all([
      db.events.findFirst({
        where: { venue_id: venueId, ...venueTakeoverWhere(now, { viewerAge }) },
        orderBy: { start_time: "asc" },
        select: { id: true },
      }),
      db.events.findFirst({
        where: {
          venue_id: venueId,
          ...venueTakeoverWhere(now, { viewerAge, leadMinutes: (dayEnd.getTime() - now.getTime()) / 60_000 }),
        },
        orderBy: { start_time: "asc" },
        select: { id: true, title: true, slug: true, cover_image_url: true, start_time: true, end_time: true },
      }),
      db.event_check_ins.count({ where: liveHere }),
      db.event_check_ins.findFirst({
        where: { ...liveHere, user_id: userId },
        select: { event_id: true, expires_at: true, stay_until: true },
      }),
    ])
    const room = mine
      ? await db.chat_groups.findUnique({ where: { event_id: mine.event_id }, select: { id: true } })
      : null

    const hasArea = validateGeofence(venue.geofence).ok
    // Whether "Own this place? Claim it" applies.
    const claimed = venue.owner_org_id !== null
    const closedReason = takeover ? "event_live_here" : hasArea ? null : "no_check_in_area"

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
        claimed,
      },
      live: {
        open: closedReason === null,
        closedReason,
        eventId: takeover?.id ?? null,
        liveNow: liveCountBucket(liveCount),
        youAreLive: mine !== null,
        expiresAt: mine?.expires_at?.toISOString() ?? null,
        stay: mine ? mine.stay_until !== null : false,
        venueDayId: mine?.event_id ?? null,
        chatGroupId: room?.id ?? null,
      },
      tonight: tonight
        ? {
            id: tonight.id,
            title: tonight.title,
            slug: tonight.slug,
            coverImageUrl: tonight.cover_image_url,
            startTime: tonight.start_time,
            endTime: tonight.end_time,
          }
        : null,
    })
  } catch (error) {
    logger.error("Venue detail error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to load the venue")
  }
}
