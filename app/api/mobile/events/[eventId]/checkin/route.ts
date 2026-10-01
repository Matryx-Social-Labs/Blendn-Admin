import { closedDoorMessage } from "@/lib/checkin-messages"
import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { db } from "@/lib/db"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { resolveFence } from "@/lib/geofence"
import {
  ErrorCode,
  successResponse,
  validationErrorResponse,
  unauthorizedResponse,
  notFoundResponse,
  errorResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { checkinSchema } from "@/lib/validations/event"
import { recordRefusal } from "@/lib/check-in-refusals"
import { resolveOccurrence } from "@/lib/occurrences"
import { canJoinEvent } from "@/lib/socket-auth"
import { readJson, isUuid } from "@/lib/api-input"
import { fenceRefusal, personAtTheDoor, seatAtTheDoor, vagueFixRefusal } from "@/lib/check-in-core"

interface RouteParams {
  params: Promise<{ eventId: string }>
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { eventId } = await params
    if (!isUuid(eventId)) return errorResponse("Invalid event ID format", 400)

    // Get authenticated user
    const authUser = await getAuthenticatedUser(request)
    if (!authUser) {
      return unauthorizedResponse("Invalid or expired token")
    }

    /*
     * Rate limited on the user id, after authentication.
     *
     * It previously keyed on the last 16 characters of the raw Authorization
     * header and ran before auth — so refreshing the token handed the caller a
     * fresh bucket, which is exactly what someone probing the geofence
     * boundary would do. `userLimit` exists for this and carries a comment
     * saying header keying is the wrong choice for an authenticated route;
     * this route predates it.
     */
    const rateLimited = await rateLimit(request, userLimit("safety", "checkin", authUser.userId))
    if (rateLimited) return rateLimited

    const body = await readJson(request)

    // Validate input
    const parsed = checkinSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }

    const { latitude, longitude, deviceInfo } = parsed.data

    // The door's rules about the person and the place live in
    // lib/check-in-core.ts, shared with Go Live (PL-G03).
    const gpsAccuracy = deviceInfo?.gpsAccuracy
    const vague = vagueFixRefusal(gpsAccuracy)
    if (vague) return vague

    // Fetch event
    const event = await db.events.findUnique({
      where: { id: eventId, deleted_at: null },
      /*
       * `owner_org_id` tells staff from guests -- a check-in is staff work if
       * the person's org runs the event or owns the venue. The venue's
       * `geofence` is not read at the door any more: an event copies it when
       * saved (owner's ruling 3, `resolveFence`), so nothing can move it live.
       */
      include: { venue: { select: { owner_org_id: true } } },
    })

    /*
     * A venue day is entered by going live at its venue (`POST
     * /venues/:id/live`), which sets the window this door does not. Found by
     * id here, it does not exist: it is `unlisted`, not `private`, and would
     * otherwise pass every check below.
     */
    if (!event || event.kind === "venue_day") {
      return notFoundResponse("Event not found")
    }

    // Check if event is published
    if (event.status !== "published") {
      return errorResponse("Cannot check in to an unpublished event")
    }

    /*
     * A private event is not found for a stranger at the door either.
     *
     * Every other participation route answers a private event through
     * `attendeeEventAccess` → `canJoinEvent`; the door never read
     * `visibility` at all, so anyone holding the id and standing at the
     * venue checked in, and with the check-in came the roster and the chat
     * (SCRUM-147). Same rule, same resolver.
     */
    if (event.visibility === "private" && !(await canJoinEvent(authUser.userId, eventId))) {
      return notFoundResponse("Event not found")
    }

    const person = await personAtTheDoor(authUser.userId, { eventId, minAge: event.min_age })
    if ("refusal" in person) return person.refusal

    /*
     * Which day are they checking in to?
     *
     * Every event has at least one occurrence, so a single-evening event
     * resolves to its only one and behaves exactly as before. A multi-day run
     * resolves to today's session — which is what makes "who came on Wednesday"
     * answerable, and what stops Tuesday's check-in overwriting Monday's.
     *
     * This replaces the old start/end comparison against the whole event: on a
     * five-day conference that window was open for five days straight, so
     * someone could check in at 3am on the Wednesday from the hotel bar.
     */
    const now = new Date()
    const slot = await resolveOccurrence(eventId, now)

    if (!slot.ok) {
      /*
       * Recorded, not just refused. A cluster of `too_early` is a wrong start
       * time on the listing -- which is the second most common curation mistake
       * after a wrong pin, and produces exactly the same silence.
       */
      const occurrenceId = slot.occurrence?.id ?? null
      if (slot.reason === "too_early") {
        recordRefusal({ eventId, userId: authUser.userId, reason: "too_early", occurrenceId })
      } else if (slot.reason === "cancelled") {
        recordRefusal({ eventId, userId: authUser.userId, reason: "day_cancelled", occurrenceId })
      } else {
        recordRefusal({ eventId, userId: authUser.userId, reason: "too_late", occurrenceId })
      }
      /*
       * Named for the day, not the event: from day 2 of a run "has not
       * started yet" is false. `closedDoorMessage` says which day is next, or
       * which was called off. "none" means the event has no occurrences at
       * all, which should be impossible — every event gets one. Treated as
       * ended rather than 500: the attendee cannot act on the difference.
       */
      const closed = closedDoorMessage(slot.reason, slot.occurrence, slot.slots, event.timezone, now)
      return errorResponse(
        closed.message,
        400,
        closed.ended ? ErrorCode.EVENT_ENDED : ErrorCode.EVENT_NOT_STARTED
      )
    }
    const occurrence = slot.occurrence

    /*
     * The fence: the event's own, else the legacy point and radius
     * (`resolveFence`). Same behaviour as before: a stored geofence that fails
     * validation falls back rather than locking everyone out, because bad data
     * in one column must not take the venue offline. The venue's `geofence` is
     * not read at the door: an event copies it when saved (owner's ruling 3),
     * so nothing can move it live.
     */
    const refused = fenceRefusal({
      fence: resolveFence(event),
      point: { lat: latitude, lng: longitude },
      gpsAccuracy,
      eventId,
      userId: authUser.userId,
      occurrenceId: occurrence.id,
      noFenceMessage: "This event has no location set, so check-in is unavailable. Contact the organiser.",
    })
    if (refused) return refused

    const seat = await seatAtTheDoor({
      event,
      occurrenceId: occurrence.id,
      userId: authUser.userId,
      profile: person.profile,
      point: { lat: latitude, lng: longitude },
      deviceInfo,
      now,
    })
    const { checkIn } = seat

    return successResponse({
      checkIn: {
        id: checkIn.id,
        status: checkIn.status,
        checkInTime: checkIn.check_in_time,
        eventId: checkIn.event_id,
      },
      // Why each: see `seatAtTheDoor` in lib/check-in-core.ts.
      revealSuggestion: seat.revealSuggestion,
      intentNeeded: seat.intentNeeded,
      message: "Successfully checked in",
    })
  } catch (error) {
    if (error instanceof Error && error.message === "CAPACITY_FULL") {
      return errorResponse("Event is at full capacity")
    }
    logger.error("Check-in error", { error: error instanceof Error ? error.message : String(error) })
    return serverErrorResponse("Failed to check in")
  }
}
