import { logger } from "@/lib/logger"
import { NextRequest } from "next/server"
import { blockCounterparties } from "@/lib/conversations"
import { db } from "@/lib/db"
import { ageFrom, minAgeRefusal, stripDating } from "@/lib/age"
import { getAuthenticatedUser } from "@/lib/mobile-auth"
import { openSession } from "@/lib/presence-sessions"
import { emitEventCheckIn } from "@/lib/socket-server"
import { notifyEventCheckIn } from "@/lib/push-notifications"
import { rateLimit, userLimit } from "@/lib/rate-limit"
import { evaluateCheckIn, resolveFence, fenceVenueSelect } from "@/lib/geofence"
import {
  ErrorCode,
  successResponse,
  validationErrorResponse,
  unauthorizedResponse,
  notFoundResponse,
  errorResponse,
  serverErrorResponse,
} from "@/lib/api-response"
import { checkinSchema, MAX_GPS_ACCURACY_METERS } from "@/lib/validations/event"
import { generateUniqueAnonymousName } from "@/lib/anonymous-names"
import { recordRefusal } from "@/lib/check-in-refusals"
import { resolveOccurrence } from "@/lib/occurrences"
import { checkInKindFor } from "@/lib/checkin-kind"
import { checkOutOfOtherEvents } from "@/lib/checkout"

interface RouteParams {
  params: Promise<{ eventId: string }>
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { eventId } = await params

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

    const body = await request.json()

    // Validate input
    const parsed = checkinSchema.safeParse(body)
    if (!parsed.success) {
      return validationErrorResponse(parsed.error)
    }

    const { latitude, longitude, deviceInfo } = parsed.data

    // A fix this vague tells us nothing at all — it is not evidence of being
    // anywhere. Below the ceiling, accuracy is no longer a pass/fail gate: it
    // is folded into the distance test below, which is where it belongs.
    const gpsAccuracy = deviceInfo?.gpsAccuracy
    if (gpsAccuracy !== undefined && gpsAccuracy > MAX_GPS_ACCURACY_METERS) {
      return errorResponse(
        `GPS signal is too weak (accuracy: ${Math.round(gpsAccuracy)}m). Move to an area with better signal and try again.`,
        400,
        ErrorCode.OUT_OF_RANGE
      )
    }

    // Fetch event
    const event = await db.events.findUnique({
      where: { id: eventId, deleted_at: null },
      /*
       * The venue relation is needed twice, for two unrelated reasons, and they
       * have to be merged by hand.
       *
       * `owner_org_id` tells staff from guests -- a check-in is staff work if
       * the person's org runs the event or owns the venue. `geofence` is what
       * `resolveFence` falls back to when the event has none, which the door has
       * never consulted even though the sweeper has and `schema.prisma`
       * promises events inherit it.
       *
       * Spreading `fenceSelect` here instead would silently replace the venue
       * select and take `owner_org_id` away, and every staff check-in would
       * quietly become a guest one.
       */
      include: { venue: { select: { owner_org_id: true, ...fenceVenueSelect } } },
    })

    if (!event) {
      return notFoundResponse("Event not found")
    }

    // Check if event is published
    if (event.status !== "published") {
      return errorResponse("Cannot check in to an unpublished event")
    }

    /*
     * The age gate, at the door.
     *
     * Check-in is where this belongs: the events list hides restricted events
     * from anyone whose stated age is below the minimum, but a list is
     * discovery and can be bypassed by a link, a share or a stale cache. This
     * is the one place a person actually enters a room.
     *
     * An unknown age is refused here even though the listing tolerates it —
     * hiding every restricted event from every OAuth account, none of which has
     * an age yet, would empty their feed to punish a missing field, whereas
     * refusing at the door costs them one clear message naming the fix. The
     * same profile row is read once and reused for the intent seeding below.
     */
    const profile = await db.profiles.findUnique({
      where: { id: authUser.userId },
      select: {
        age: true,
        date_of_birth: true,
        intent_default: true,
        reveal_by_default: true,
      },
    })

    // The door is the gate, so this is the read that matters most. Derived, not
    // taken off the row: a stored age was true on signup day, and someone who
    // signed up at 17 would otherwise be refused an 18+ event a year later.
    const profileAge = ageFrom(profile)

    const ageRefusal = minAgeRefusal(profileAge, event.min_age)
    if (ageRefusal) {
      recordRefusal({ eventId, userId: authUser.userId, reason: "under_age" })
      return errorResponse(ageRefusal, 403, ErrorCode.AGE_RESTRICTED)
    }

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
        return errorResponse("Event has not started yet", 400, ErrorCode.EVENT_NOT_STARTED)
      }
      if (slot.reason === "cancelled") {
        recordRefusal({ eventId, userId: authUser.userId, reason: "day_cancelled", occurrenceId })
        return errorResponse("This day has been cancelled", 400, ErrorCode.EVENT_ENDED)
      }
      recordRefusal({ eventId, userId: authUser.userId, reason: "too_late", occurrenceId })
      // "none" means the event has no occurrences at all, which should be
      // impossible — every event gets one. Treated as ended rather than 500:
      // the attendee cannot act on the difference.
      return errorResponse("Event has already ended", 400, ErrorCode.EVENT_ENDED)
    }
    const occurrence = slot.occurrence

    /*
     * The geofence.
     *
     * Three things changed here, all of which were letting people in who should
     * not have been:
     *
     *  1. `if (event.latitude && event.longitude)` was truthiness, so an event
     *     at longitude 0 skipped the check entirely.
     *  2. An event with NO coordinates skipped it too — and nothing required
     *     coordinates to publish, so such an event accepted check-ins from
     *     anywhere on earth. It is now refused outright.
     *  3. The device's reported accuracy was a separate pass/fail gate rather
     *     than part of the distance test, so a 140m-accuracy fix 25m away
     *     passed while a good fix 35m away failed.
     *
     * `evaluateCheckIn` folds buffer and accuracy into one comparison. Legacy
     * events with no `geofence` column go through `legacyGeofence`, which maps
     * the old radius to pure extent with a zero buffer — strictly more
     * permissive than before, so nobody who could check in yesterday is
     * refused today.
     */
    /*
     * One resolver -- `resolveFence` in lib/geofence.ts.
     *
     * Same behaviour as before for the two cases this path already handled: a
     * stored geofence that fails validation falls back rather than locking
     * everyone out, because bad data in one column must not take the venue
     * offline. What is new here is the **venue's** fence, between the two --
     * `schema.prisma` has always promised events inherit it and nothing on the
     * server honoured that; the sweeper consulted it and the door did not.
     */
    const fence = resolveFence(event)

    if (!fence) {
      logger.error("Check-in attempted on an event with no geofence", { eventId })
      recordRefusal({ eventId, userId: authUser.userId, reason: "no_geofence" })
      return errorResponse(
        "This event has no location set, so check-in is unavailable. Contact the organiser.",
        400,
        ErrorCode.OUT_OF_RANGE
      )
    }

    const verdict = evaluateCheckIn({ lat: latitude, lng: longitude }, fence, gpsAccuracy)
    if (!verdict.ok) {
      /*
       * The refusal that matters. Everybody twenty metres out is a pin on the
       * wrong side of the street; a wide spread is a fence too tight for the
       * venue. Neither is visible without recording the shortfall.
       *
       * The shortfall and the reported accuracy, never the coordinates -- see
       * lib/check-in-refusals.ts.
       */
      recordRefusal({
        eventId,
        userId: authUser.userId,
        reason: "out_of_range",
        occurrenceId: occurrence.id,
        shortfallMetres: verdict.shortfall,
        accuracyMetres: gpsAccuracy,
      })
      return errorResponse(
        `You're about ${Math.round(verdict.shortfall)}m outside the check-in area. Move closer to the venue and try again.`,
        400,
        ErrorCode.OUT_OF_RANGE
      )
    }

    // You cannot be in two rooms. Goes through the shared checkout path so the
    // socket event and the chat cutoff cannot be forgotten here and remembered
    // in the manual route.
    await checkOutOfOtherEvents(authUser.userId, eventId, now)

    /*
     * Capacity does not gate check-in.
     *
     * The geofence deliberately covers the pavement and the door, so a
     * 100-capacity venue with 100 inside and 20 queuing has 120 people
     * legitimately within the boundary. Refusing the hundred-and-first denied
     * them the chatroom — the actual product — and erased them from attendance,
     * leaving the organiser believing 100 came when 120 did.
     *
     * Check-in is a presence proof, not a ticket. Nothing here sells admission;
     * the door does. Occupancy is now counted from these rows (lib/occupancy.ts)
     * rather than kept in a column, so a room over its stated size becomes a
     * signal the organiser can see instead of an error the attendee hits.
     */
    // Memberships read directly rather than through `actorFor`, which wants a
    // dashboard role the mobile JWT does not carry. Passing a fabricated role
    // to get at the membership lookup would break the day `actorFor` starts
    // branching on it.
    const memberships = await db.organisation_members.findMany({
      where: { user_id: authUser.userId },
      select: { org_id: true },
    })
    const kind = checkInKindFor({ orgIds: memberships.map((m) => m.org_id) }, event)

    /*
     * Seed matching preferences from the profile.
     *
     * Only on create. Someone who set "just here" for tonight and then stepped
     * out for a cigarette must not have that silently reset to their default
     * when they check back in — the per-event answer is the one they gave most
     * recently, and re-checking in is not a decision to change it.
     */
    /*
     * A profile written before the 18+ rule existed can still carry `dating`.
     *
     * Stripped rather than refused: the person is not making a choice at this
     * moment, and keeping someone out of the room over a stale profile field
     * would be a strange thing to do at a door they are standing at. The write
     * paths refuse; this one, which only copies, filters.
     */
    const seededIntents = stripDating(profile?.intent_default ?? [], profileAge)

    // Create or update check-in record
    const checkIn = await db.event_check_ins.upsert({
      where: {
        occurrence_id_user_id: { occurrence_id: occurrence.id, user_id: authUser.userId },
      },
      create: {
        event_id: eventId,
        occurrence_id: occurrence.id,
        user_id: authUser.userId,
        kind,
        status: "checked_in",
        check_in_time: now,
        latitude,
        longitude,
        /*
         * `deviceInfo` is optional in the request schema, so it is `undefined`
         * whenever a client omits it — and no static scan can see that. The
         * source reads `device_info: deviceInfo`, which is indistinguishable
         * from every other field; only `strictUndefinedChecks` at runtime
         * catches it. That is the argument for the flag over the ratchet.
         */
        ...(deviceInfo !== undefined && { device_info: deviceInfo }),
      },
      update: {
        status: "checked_in",
        check_in_time: now,
        latitude,
        longitude,
        ...(deviceInfo !== undefined && { device_info: deviceInfo }),
        updated_at: now,
      },
    })

    /*
     * And open a presence session.
     *
     * Written beside the check-in rather than instead of it: `event_check_ins`
     * is still the source of truth for every reader, and will be until they
     * move. What this buys immediately is the thing the old shape cannot hold —
     * somebody stepping outside and coming back produces a *second* session
     * rather than overwriting their arrival.
     *
     * `openSession` is idempotent, so checking in twice without leaving
     * refreshes the heartbeat instead of opening a second session. The partial
     * unique in the migration enforces that against a race the check cannot
     * see.
     *
     * Deliberately not awaited inside the check-in transaction: a failure here
     * must not refuse somebody standing at the door. The door is the product;
     * this is bookkeeping that runs beside it.
     */
    openSession({
      eventId,
      occurrenceId: occurrence.id,
      userId: authUser.userId,
      kind,
      at: now,
      lat: latitude,
      lng: longitude,
      accuracy: gpsAccuracy,
    }).catch((err) =>
      logger.error("Opening presence session failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    )

    /*
     * Seed the event preferences, once per event rather than once per day.
     *
     * `create`-only on purpose. Someone who set "just here" for tonight and
     * stepped out for a cigarette must not have it reset to their default when
     * they check back in — and on a multi-day event, day three must not
     * overwrite what they chose on day one. Re-checking in is not a decision to
     * change your answer.
     *
     * That guarantee used to be "only on create" of a *check-in* row, which
     * stopped being the same thing the day check-ins became per-occurrence: on
     * a five-day event, every new day was a create.
     */
    await db.event_match_preferences.upsert({
      where: { event_id_user_id: { event_id: eventId, user_id: authUser.userId } },
      create: {
        event_id: eventId,
        user_id: authUser.userId,
        intent: seededIntents,
        /*
         * Always false. Never seeded from `reveal_by_default`.
         *
         * This used to read the profile default, which meant walking into a
         * room could name you — `matches/preferences` says two files away that
         * reveal is "never flipped on implicitly", and this was the implicit
         * flip. Someone who chose to be visible at a work meetup in March was
         * visible at a club in August without touching anything.
         *
         * The default is not discarded: it comes back as `revealSuggestion`
         * below, and the app offers it as a tap. Suggesting rather than undoing
         * is the whole point — there is no window in which somebody is named
         * before they have answered.
         */
        revealed: false,
      },
      update: {},
    })

    // Ensure chat group exists and add user
    let chatGroup = await db.chat_groups.findUnique({
      where: { event_id: eventId },
    })

    if (!chatGroup) {
      chatGroup = await db.chat_groups.create({
        data: {
          event_id: eventId,
          name: `${event.title} Chat`,
          description: `Chat for ${event.title}`,
          status: "active",
          member_count: 0,
        },
      })
    }

    const existingMembership = await db.chat_group_members.findUnique({
      where: {
        chat_group_id_user_id: {
          chat_group_id: chatGroup.id,
          user_id: authUser.userId,
        },
      },
    })

    if (existingMembership) {
      if (existingMembership.status !== "active" || existingMembership.last_allowed_at || !existingMembership.anonymous_name) {
        const anonName =
          existingMembership.anonymous_name ||
          (await generateUniqueAnonymousName(
            chatGroup.id,
            { eventId, userId: authUser.userId }
          ))
        await db.chat_group_members.update({
          where: {
            chat_group_id_user_id: {
              chat_group_id: chatGroup.id,
              user_id: authUser.userId,
            },
          },
          data: {
            status: "active",
            last_allowed_at: null,
            anonymous_name: anonName,
            updated_at: now,
          },
        })
      }
    } else {
      const anonName = await generateUniqueAnonymousName(
        chatGroup.id,
        { eventId, userId: authUser.userId }
      )
      await db.chat_group_members.create({
        data: {
          chat_group_id: chatGroup.id,
          user_id: authUser.userId,
          role: "member",
          status: "active",
          last_allowed_at: null,
          anonymous_name: anonName,
        },
      })

      await db.chat_groups.update({
        where: { id: chatGroup.id },
        data: {
          member_count: {
            increment: 1,
          },
        },
      })
    }

    // Get the anonymous name for socket emit and push notification
    const updatedMembership = await db.chat_group_members.findUnique({
      where: {
        chat_group_id_user_id: {
          chat_group_id: chatGroup.id,
          user_id: authUser.userId,
        },
      },
      select: { anonymous_name: true },
    })
    const displayName = updatedMembership?.anonymous_name || "Someone"

    // Emit real-time check-in event (anonymous)
    emitEventCheckIn(
      eventId,
      authUser.userId,
      displayName,
      undefined
    )

    /*
     * Send push notifications to other checked-in users (async, don't await).
     *
     * Minus anyone in a block relationship with the arriver. This told you that
     * a person you had blocked had just walked into the room -- the single most
     * unwelcome notification the product could send, and the reason "block" has
     * to mean more than "cannot DM me".
     */
    blockCounterparties(authUser.userId)
      .then((blockedIds) =>
        db.event_check_ins.findMany({
          where: {
            event_id: eventId,
            status: "checked_in",
            user_id: { not: authUser.userId, ...(blockedIds.length ? { notIn: blockedIds } : {}) },
          },
          select: { user_id: true },
        })
      )
      .then((checkIns) => {
        const userIds = checkIns.map((c) => c.user_id)
        if (userIds.length > 0) {
          return notifyEventCheckIn(
            userIds,
            displayName,
            event.title,
            eventId,
            authUser.userId
          )
        }
      })
      .catch((err) => logger.error("Push notification failed", { error: err instanceof Error ? err.message : String(err) }))

    return successResponse({
      checkIn: {
        id: checkIn.id,
        status: checkIn.status,
        checkInTime: checkIn.check_in_time,
        eventId: checkIn.event_id,
      },
      /*
       * The suggestion, not the state.
       *
       * True when this person has `reveal_by_default` set — which used to mean
       * they were silently revealed here. Now it means the app should ask:
       * "you usually join as Sagar, do that here?" A tap turns it on.
       *
       * Sent on the check-in response rather than fetched separately so the
       * prompt can be shown immediately, and because a second round trip is a
       * window in which the room renders with no prompt at all.
       *
       * `revealed` is deliberately absent: it is always false at this point,
       * and returning it would invite a client to treat it as the answer.
       */
      revealSuggestion: profile?.reveal_by_default === true,
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
