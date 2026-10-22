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
import { goLiveSchema, goLiveWindow } from "@/lib/go-live"
import { logger } from "@/lib/logger"
import { plusRequired } from "@/lib/plus"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { clientIpFrom } from "@/lib/client-ip"
import { scheduleLiveEnd } from "@/lib/live-timers"
import { venueDayAt, venueDayBounds, venueDayFor } from "@/lib/venue-day"
import { eventTakingOver, goLiveArea } from "@/lib/venue-visibility"

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
 *   404  no such venue, or archived or deleted
 *   403  not onboarded / not an adult (`personAtTheDoor`)
 *   409  `EVENT_LIVE_HERE {eventId}` — a real event has the venue: on now or
 *        starting within the hour (`venueTakeoverWhere`). Before the fence, so
 *        somebody at the door is sent to the event, not told they are outside
 *   400  `GPS_TOO_VAGUE` a fix too vague; `NO_CHECK_IN_AREA` no area at this
 *        venue; `OUT_OF_RANGE` outside it
 *   403  `PLUS_REQUIRED` for "stay" where Blendn+ is gated (the venue's city
 *        is in `PLUS_GATING`) and the person holds neither Plus nor a Night
 *        Pass — last, so the paywall only ever stands where "stay" would
 *        otherwise have worked (`lib/plus.ts`, step 11)
 *
 * Going live again while live extends the window, never shortens it. Going
 * live somewhere else — or checking in to an event — ends this one as a
 * switch.
 */
/** Go Live attempts from one address a minute: a ceiling for scripts, far above a crowded venue's wifi. */
const PER_IP_PER_MINUTE = 300
/** Go Live attempts at one venue a minute, whoever makes them. */
const PER_VENUE_PER_MINUTE = 240
/**
 * Too close to the reset to be worth a window in today's room: going live in
 * the last minutes opens tomorrow's instead (D-4) — a window of seconds, which
 * would end the moment it began, is no window.
 */
export const ROLLOVER_MINUTES = 5

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { venueId } = await params
    if (!isUuid(venueId)) return notFoundResponse("Venue not found")

    const authUser = await getAuthenticatedUser(request)
    if (!authUser) return unauthorizedResponse("Invalid or expired token")
    const userId = authUser.userId

    // The check-in's bucket shape, its own scope: probing a fence by
    // refreshing a token must not get a fresh allowance here either. Then a
    // ceiling per address and per venue, so no one source can make a venue's
    // day, or hammer its door, at script speed.
    const limited =
      (await rateLimit(request, userLimit("safety", "go-live", userId))) ??
      (await rateLimit(request, {
        windowMs: 60_000,
        maxRequests: PER_IP_PER_MINUTE,
        keyGenerator: (req) => `go-live-ip:${clientIpFrom(req.headers)}`,
      })) ??
      (await rateLimit(request, {
        windowMs: 60_000,
        maxRequests: PER_VENUE_PER_MINUTE,
        keyGenerator: () => `go-live-venue:${venueId}`,
      }))
    if (limited) return limited

    const parsed = goLiveSchema.safeParse(await readJson(request))
    if (!parsed.success) return validationErrorResponse(parsed.error)
    const input = parsed.data
    const choice = "stay" in input ? ({ stay: true } as const) : { minutes: input.minutes }

    const venue = await db.venues.findFirst({
      where: { id: venueId, deleted_at: null, status: "active" },
      select: { id: true, name: true, city: true, geofence: true, timezone: true, day_reset_hour: true },
    })
    if (!venue) return notFoundResponse("Venue not found")

    // Strictly 18+, with a known age (`personAtTheDoor`).
    const person = await personAtTheDoor(userId, null)
    if ("refusal" in person) return person.refusal

    const now = new Date()
    const takeover = await eventTakingOver(venueId, now, { viewerAge: ageFrom(person.profile) })
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

    const gpsAccuracy = input.deviceInfo?.gpsAccuracy
    // Split from OUT_OF_RANGE (step 5): a vague fix and a venue with no area are not fixed by walking.
    const vague = vagueFixRefusal(gpsAccuracy, ErrorCode.GPS_TOO_VAGUE)
    if (vague) return vague

    /*
     * Which day, and judged against which area — before anything is written.
     * The day is found, never made, until the person is known to be standing
     * there: somebody elsewhere must not be able to create a venue's day (and
     * its room) by asking. The area is the one the day copied when it was made
     * (owner's ruling 3), or the venue's own when nobody has gone live yet —
     * the same answer `GET /venues/:id` gives (`goLiveArea`).
     */
    const { end } = venueDayBounds(venue.timezone, venue.day_reset_hour, now)
    const at = end.getTime() - now.getTime() < ROLLOVER_MINUTES * 60_000 ? end : now
    const existing = await venueDayAt(venueId, at)
    if (existing?.deleted_at) return notFoundResponse("Venue not found")
    const area = goLiveArea(existing, venue)
    const existingOccurrence = existing
      ? await db.event_occurrences.findFirst({ where: { event_id: existing.id }, select: { id: true } })
      : null

    const refused = fenceRefusal({
      fence: area,
      point: { lat: input.latitude, lng: input.longitude },
      gpsAccuracy,
      userId,
      record: existing && existingOccurrence ? { eventId: existing.id, occurrenceId: existingOccurrence.id } : null,
      noFenceMessage: "This place has no check-in area yet, so you can't go live here.",
      noFenceCode: ErrorCode.NO_CHECK_IN_AREA,
      // Never the distance: a venue's area is nobody's to map by asking (D-x6).
      outsideMessage: `You're not at ${venue.name} yet.`,
    })
    if (refused) return refused

    // Blendn+ where the venue's city is gated; everyone's in its launch season.
    if ("stay" in choice && (await plusRequired(userId, venue.city, now))) {
      return errorResponse("Staying live is part of Blendn+.", 403, ErrorCode.PLUS_REQUIRED)
    }

    const day = await venueDayFor(venueId, at)
    if (!day) return notFoundResponse("Venue not found")

    const event = await db.events.findUniqueOrThrow({
      where: { id: day.id },
      select: {
        id: true,
        kind: true,
        title: true,
        venue_name: true,
        organizer_org_id: true,
        deleted_at: true,
        venue: { select: { owner_org_id: true } },
      },
    })
    // `venueDayFor` hands back a day somebody deleted (it still holds the
    // day's slot); deleting today's room is a decision that lasts the day.
    if (event.deleted_at) return notFoundResponse("Venue not found")

    /*
     * Already live here? Then this extends. A window that ended but has not
     * been swept yet ends first, as `expired` at its own time, so going again
     * after expiry is a new session rather than one stretched over the gap.
     */
    const current = await db.event_check_ins.findUnique({
      where: { occurrence_id_user_id: { occurrence_id: day.occurrenceId, user_id: userId } },
      select: { id: true, status: true, expires_at: true, stay_until: true },
    })
    let open: Date | null = null
    if (current?.status === "checked_in" && current.expires_at) {
      if (current.expires_at <= now) await performCheckout(current.id, "expired", current.expires_at)
      else open = current.expires_at
    }
    const live = goLiveWindow(choice, now, day.end_time, { expiresAt: open, stayUntil: current?.stay_until ?? null })

    const seat = await seatAtTheDoor({
      event,
      occurrenceId: day.occurrenceId,
      userId,
      profile: person.profile,
      point: { lat: input.latitude, lng: input.longitude },
      deviceInfo: input.deviceInfo,
      now,
      live,
      extending: open !== null,
    })
    // Ends at its second, not at the next sweep (`lib/live-timers.ts`).
    scheduleLiveEnd(seat.checkIn.id, live.expiresAt)

    return successResponse({
      venueDayId: day.id,
      chatGroupId: seat.chatGroupId,
      expiresAt: live.expiresAt.toISOString(),
      stay: live.stay,
      stayUntil: live.stay ? live.stayUntil?.toISOString() ?? null : null,
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
