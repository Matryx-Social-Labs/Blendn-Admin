import { NextRequest, NextResponse } from "next/server"

import { ageFrom } from "@/lib/age"
import { isUuid, readJson } from "@/lib/api-input"
import {
  ErrorCode,
  errorResponse,
  notFoundResponse,
  serverErrorResponse,
  successResponse,
  unauthorizedResponse,
  validationErrorResponse,
} from "@/lib/api-response"
import { fenceRefusal, personAtTheDoor, seatAtTheDoor, vagueFixRefusal } from "@/lib/check-in-core"
import { performCheckout } from "@/lib/checkout"
import { db } from "@/lib/db"
import { plusGating } from "@/lib/env"
import { validateGeofence } from "@/lib/geofence"
import { goLiveSchema, goLiveWindow } from "@/lib/go-live"
import { logger } from "@/lib/logger"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { venueDayFor } from "@/lib/venue-day"
import { venueTakeoverWhere } from "@/lib/venue-visibility"

interface RouteParams {
  params: Promise<{ venueId: string }>
}

/**
 * Go Live at a venue: `{ minutes: 20 | 45 | 60 }` or `{ stay: true }`, with
 * where you are (docs/CHECKIN.md, "Go Live").
 *
 * The only door into a venue's room. It finds or makes the venue's day
 * (`venueDayFor`, race-safe), and checks you in to it through the same door
 * an event uses (`lib/check-in-core.ts`) with a window: `expires_at`. When
 * the window ends the sweeper checks you out (`expired`) and the room is
 * closed to you (`liveInVenueDay`).
 *
 * Refused, in this order (PL-U08):
 *   403  `PLUS_REQUIRED` for "stay" while `PLUS_GATING` is on
 *   404  no such venue, or archived or deleted
 *   403  not onboarded / not an adult (`personAtTheDoor`)
 *   409  `EVENT_LIVE_HERE {eventId}` — a real event has the venue: on now or
 *        starting within the hour (`venueTakeoverWhere`). Before the fence, so
 *        somebody at the door is sent to the event, not told they are outside
 *   400  a fix too vague, no check-in area at this venue, or outside it
 *
 * Going live again while live extends the window, never shortens it. Going
 * live somewhere else — or checking in to an event — ends this one as a
 * switch.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { venueId } = await params
    if (!isUuid(venueId)) return notFoundResponse("Venue not found")

    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const userId = authUser.userId

    // The check-in's bucket shape, its own scope: probing a fence by
    // refreshing a token must not get a fresh allowance here either.
    const limited = await rateLimit(request, userLimit("safety", "go-live", userId))
    if (limited) return limited

    const parsed = goLiveSchema.safeParse(await readJson(request))
    if (!parsed.success) return validationErrorResponse(parsed.error)
    const input = parsed.data
    const choice = "stay" in input ? ({ stay: true } as const) : { minutes: input.minutes }

    // Blendn+ once gated (step 11 grants it); until then "stay" is everyone's.
    if ("stay" in choice && plusGating()) {
      return errorResponse("Staying live is part of Blendn+.", 403, ErrorCode.PLUS_REQUIRED)
    }

    const venue = await db.venues.findFirst({
      where: { id: venueId, deleted_at: null, status: "active" },
      select: { id: true },
    })
    if (!venue) return notFoundResponse("Venue not found")

    // Strictly 18+, as at every door; a venue day has no age rule of its own.
    const person = await personAtTheDoor(userId, null)
    if ("refusal" in person) return person.refusal

    const now = new Date()
    const takeover = await db.events.findFirst({
      where: { venue_id: venueId, ...venueTakeoverWhere(now, { viewerAge: ageFrom(person.profile) }) },
      orderBy: { start_time: "asc" },
      select: { id: true, title: true },
    })
    if (takeover) {
      return NextResponse.json(
        {
          success: false,
          error: `${takeover.title} is on here. Check in to it instead.`,
          errorCode: ErrorCode.EVENT_LIVE_HERE,
          eventId: takeover.id,
        },
        { status: 409 }
      )
    }

    // After the refusals that need no day, so a 409 or a 403 makes none.
    const day = await venueDayFor(venueId, now)
    if (!day) return notFoundResponse("Venue not found")

    const gpsAccuracy = input.deviceInfo?.gpsAccuracy
    const vague = vagueFixRefusal(gpsAccuracy)
    if (vague) return vague

    const event = await db.events.findUniqueOrThrow({
      where: { id: day.id },
      select: {
        id: true,
        kind: true,
        title: true,
        venue_name: true,
        organizer_org_id: true,
        geofence: true,
        deleted_at: true,
        venue: { select: { owner_org_id: true } },
      },
    })
    // `venueDayFor` hands back a day somebody deleted (it still holds the
    // day's slot); deleting today's room is a decision that lasts the day.
    if (event.deleted_at) return notFoundResponse("Venue not found")

    /*
     * The venue's area as the day copied it, and only that: no fallback to the
     * venue's point and the events' default radius (`resolveFence`'s legacy
     * branch). A venue nobody drew an area for has none, and Go Live is
     * refused there rather than judged against a 30-metre guess.
     */
    const area = validateGeofence(event.geofence)
    const refused = fenceRefusal({
      fence: area.ok ? area.fence : null,
      point: { lat: input.latitude, lng: input.longitude },
      gpsAccuracy,
      eventId: day.id,
      userId,
      occurrenceId: day.occurrenceId,
      noFenceMessage: "This place has no check-in area yet, so you can't go live here.",
    })
    if (refused) return refused

    /*
     * Already live here? Then this extends. A window that ended but has not
     * been swept yet ends first, as `expired` at its own time, so going again
     * after expiry is a new session rather than one stretched over the gap.
     */
    const current = await db.event_check_ins.findUnique({
      where: { occurrence_id_user_id: { occurrence_id: day.occurrenceId, user_id: userId } },
      select: { id: true, status: true, expires_at: true },
    })
    let openWindow: Date | null = null
    if (current?.status === "checked_in" && current.expires_at) {
      if (current.expires_at <= now) await performCheckout(current.id, "expired", current.expires_at)
      else openWindow = current.expires_at
    }
    const live = goLiveWindow(choice, now, day.end_time, openWindow)

    const seat = await seatAtTheDoor({
      event,
      occurrenceId: day.occurrenceId,
      userId,
      profile: person.profile,
      point: { lat: input.latitude, lng: input.longitude },
      deviceInfo: input.deviceInfo,
      now,
      live,
    })

    return successResponse({
      venueDayId: day.id,
      chatGroupId: seat.chatGroupId,
      expiresAt: live.expiresAt.toISOString(),
      stay: live.stayUntil !== null,
      stayUntil: live.stayUntil?.toISOString() ?? null,
      checkIn: {
        id: seat.checkIn.id,
        status: seat.checkIn.status,
        checkInTime: seat.checkIn.check_in_time,
      },
      revealSuggestion: seat.revealSuggestion,
      intentNeeded: seat.intentNeeded,
    })
  } catch (error) {
    logger.error("Go live error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to go live")
  }
}
