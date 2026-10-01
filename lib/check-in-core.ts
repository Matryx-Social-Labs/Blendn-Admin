import type { event_kind, Prisma } from "@prisma/client"

import { outOfRangeMessage } from "@/lib/checkin-messages"
import { logger } from "@/lib/logger"
import { blockCounterparties } from "@/lib/conversations"
import { db } from "@/lib/db"
import { ageFrom, FINISH_ONBOARDING, mayParticipate, minAgeRefusal, stripDating } from "@/lib/age"
import { openSession } from "@/lib/presence-sessions"
import { emitEventCheckIn } from "@/lib/socket-server"
import { evaluateCheckIn, type Geofence } from "@/lib/geofence"
import { ErrorCode, errorResponse } from "@/lib/api-response"
import { MAX_GPS_ACCURACY_METERS, type CheckinInput } from "@/lib/validations/event"
import { claimAnonymousName } from "@/lib/anonymous-names"
import { recordRefusal } from "@/lib/check-in-refusals"
import { checkInKindFor } from "@/lib/checkin-kind"
import { checkOutOfOtherEvents } from "@/lib/checkout"
import { activeMembership } from "@/lib/org-membership"
import { violatedConstraint } from "@/lib/prisma-errors"

/**
 * The door: one implementation for the two ways into a room.
 *
 * `POST /events/:id/checkin` (an event) and `POST /venues/:id/live` (a venue's
 * day, Go Live) both admit a person standing somewhere into a room. The rules
 * about the person and the place — how vague a GPS fix may be, who may take
 * part, the age gate, the fence and what a refusal records — and everything a
 * check-in writes live here once, so the two doors cannot drift (PL-G03). What
 * differs stays in each route: which room (an event's occurrence, or the
 * venue's day) and its own refusals (a closed day; an event live at the venue).
 *
 * Each gate returns the response to send, or null to carry on. They are
 * separate rather than one call so the event route keeps its order exactly:
 * the occurrence is resolved between the age gate and the fence.
 */

/**
 * A fix this vague tells us nothing at all — it is not evidence of being
 * anywhere. Below the ceiling, accuracy is no longer a pass/fail gate: it is
 * folded into the distance test (`fenceRefusal`), which is where it belongs.
 */
export function vagueFixRefusal(gpsAccuracy: number | undefined) {
  if (gpsAccuracy === undefined || gpsAccuracy <= MAX_GPS_ACCURACY_METERS) return null
  return errorResponse(
    `GPS signal is too weak (accuracy: ${Math.round(gpsAccuracy)}m). Move to an area with better signal and try again.`,
    400,
    ErrorCode.OUT_OF_RANGE
  )
}

const doorProfileSelect = {
  onboarded: true,
  age: true,
  date_of_birth: true,
  intent_default: true,
  reveal_by_default: true,
} as const

export type DoorProfile = Prisma.profilesGetPayload<{ select: typeof doorProfileSelect }> | null

/**
 * The person at the door: may they take part, and are they old enough for
 * this room?
 *
 * Check-in is where the age gate belongs: the events list hides restricted
 * events from anyone whose stated age is below the minimum, but a list is
 * discovery and can be bypassed by a link, a share or a stale cache. This is
 * the one place a person actually enters a room.
 *
 * An unknown age is refused here even though the listing tolerates it —
 * hiding every restricted event from every OAuth account, none of which has an
 * age yet, would empty their feed to punish a missing field, whereas refusing
 * at the door costs them one clear message naming the fix. The same profile
 * row is read once and returned for the seat (intent seeding, the reveal
 * suggestion).
 */
export async function personAtTheDoor(
  userId: string,
  /** The event's own age rule, when it has one; null for a venue day. */
  room: { eventId: string; minAge: number | null } | null
): Promise<{ refusal: ReturnType<typeof errorResponse> } | { profile: DoorProfile }> {
  const profile = await db.profiles.findUnique({ where: { id: userId }, select: doorProfileSelect })

  // The door is the gate, so this is the read that matters most. Derived, not
  // taken off the row: a stored age was true on signup day, and someone who
  // signed up at 17 would otherwise be refused an 18+ event a year later.
  const profileAge = ageFrom(profile)

  // Not onboarded and no adult age on file: held here as at every door (SCRUM-331).
  if (!mayParticipate(profile)) return { refusal: errorResponse(FINISH_ONBOARDING, 403, ErrorCode.FORBIDDEN) }

  const ageRefusal = room && minAgeRefusal(profileAge, room.minAge)
  if (room && ageRefusal) {
    recordRefusal({ eventId: room.eventId, userId, reason: "under_age" })
    return { refusal: errorResponse(ageRefusal, 403, ErrorCode.AGE_RESTRICTED) }
  }
  return { profile }
}

/**
 * The fence: inside it, or refused and recorded.
 *
 * Three things changed here over time, all of which were letting people in who
 * should not have been:
 *
 *  1. `if (event.latitude && event.longitude)` was truthiness, so an event at
 *     longitude 0 skipped the check entirely.
 *  2. An event with NO coordinates skipped it too — and nothing required
 *     coordinates to publish, so such an event accepted check-ins from
 *     anywhere on earth. It is now refused outright (`noFenceMessage`).
 *  3. The device's reported accuracy was a separate pass/fail gate rather than
 *     part of the distance test, so a 140m-accuracy fix 25m away passed while a
 *     good fix 35m away failed.
 *
 * `evaluateCheckIn` folds buffer and accuracy into one comparison. Which fence
 * is the caller's to resolve — `resolveFence` for an event (its own, then the
 * legacy point and radius), the venue day's copied area alone for Go Live —
 * and the judging is this one function.
 */
export function fenceRefusal(input: {
  fence: Geofence | null
  point: { lat: number; lng: number }
  gpsAccuracy: number | undefined
  eventId: string
  userId: string
  occurrenceId: string
  noFenceMessage: string
}) {
  if (!input.fence) {
    logger.error("Check-in attempted with no area to check against", { eventId: input.eventId })
    recordRefusal({ eventId: input.eventId, userId: input.userId, reason: "no_geofence" })
    return errorResponse(input.noFenceMessage, 400, ErrorCode.OUT_OF_RANGE)
  }

  const verdict = evaluateCheckIn(input.point, input.fence, input.gpsAccuracy)
  if (verdict.ok) return null
  /*
   * The refusal that matters. Everybody twenty metres out is a pin on the
   * wrong side of the street; a wide spread is a fence too tight for the
   * venue. Neither is visible without recording the shortfall.
   *
   * The shortfall and the reported accuracy, never the coordinates -- see
   * lib/check-in-refusals.ts.
   */
  recordRefusal({
    eventId: input.eventId,
    userId: input.userId,
    reason: "out_of_range",
    occurrenceId: input.occurrenceId,
    shortfallMetres: verdict.shortfall,
    accuracyMetres: input.gpsAccuracy,
  })
  return errorResponse(outOfRangeMessage(verdict.shortfall), 400, ErrorCode.OUT_OF_RANGE)
}

export interface SeatInput {
  event: {
    id: string
    kind: event_kind
    title: string
    venue_name: string | null
    organizer_org_id: string | null
    venue: { owner_org_id: string | null } | null
  }
  occurrenceId: string
  userId: string
  profile: DoorProfile
  point: { lat: number; lng: number }
  deviceInfo: CheckinInput["deviceInfo"]
  now: Date
  /** A Go Live window: written to the check-in and, as the room's cut-off, to the membership. */
  live?: { expiresAt: Date; stayUntil: Date | null }
}

/**
 * Everything a check-in writes once the gates have passed: out of any other
 * room, the check-in row, a presence session, the event preferences, the room
 * and its pseudonym, and the arrival on the live roster.
 */
export async function seatAtTheDoor(input: SeatInput) {
  const { event, occurrenceId, userId, profile, now, live } = input
  const eventId = event.id
  const { lat: latitude, lng: longitude } = input.point
  const deviceInfo = input.deviceInfo
  const gpsAccuracy = deviceInfo?.gpsAccuracy

  // You cannot be in two rooms. Goes through the shared checkout path so the
  // socket event and the chat cutoff cannot be forgotten here and remembered
  // in the manual route.
  await checkOutOfOtherEvents(userId, eventId, now)

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
    where: { user_id: userId, ...activeMembership },
    select: { org_id: true },
  })
  // At a venue day too: staff of the organisation that owns the venue going
  // live at their own venue are working, as at an event there (step 4).
  const kind = checkInKindFor({ orgIds: memberships.map((m) => m.org_id) }, event)

  /*
   * A profile written before the 18+ rule existed can still carry `dating`.
   *
   * Stripped rather than refused: the person is not making a choice at this
   * moment, and keeping someone out of the room over a stale profile field
   * would be a strange thing to do at a door they are standing at. The write
   * paths refuse; this one, which only copies, filters.
   */
  const seededIntents = stripDating(profile?.intent_default ?? [], ageFrom(profile))

  // A Go Live's window, on the row the sweeper expires (null for an event).
  const window = live ? { expires_at: live.expiresAt, stay_until: live.stayUntil } : {}

  // Create or update check-in record
  const checkIn = await db.event_check_ins.upsert({
    where: {
      occurrence_id_user_id: { occurrence_id: occurrenceId, user_id: userId },
    },
    create: {
      event_id: eventId,
      occurrence_id: occurrenceId,
      user_id: userId,
      kind,
      status: "checked_in",
      check_in_time: now,
      latitude,
      longitude,
      ...window,
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
      /*
       * Coming back after a check-out reuses the row (one per person per
       * occurrence), and the old check-out timestamp stayed on it beside
       * `checked_in`. The Banter tab's live section wants both `checked_in`
       * and no `check_out_time`, so the room somebody had just walked back
       * into was not listed as live. Found by leaving and returning.
       */
      check_out_time: null,
      latitude,
      longitude,
      ...window,
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
    occurrenceId,
    userId,
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
  const prefs = await db.event_match_preferences.upsert({
    where: { event_id_user_id: { event_id: eventId, user_id: userId } },
    create: {
      event_id: eventId,
      user_id: userId,
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
    select: { intent: true },
  })

  const chatGroupId = await seatInRoom(input, eventId, now)

  // Get the anonymous name for socket emit and push notification, and who
  // they are for the recipients whose roster would name them.
  const [updatedMembership, arriver] = await Promise.all([
    db.chat_group_members.findUnique({
      where: { chat_group_id_user_id: { chat_group_id: chatGroupId, user_id: userId } },
      select: { anonymous_name: true },
    }),
    db.user.findUnique({
      where: { id: userId },
      select: { name: true, profile: { select: { photos: true } } },
    }),
  ])
  const displayName = updatedMembership?.anonymous_name || "Someone"

  /*
   * Whoever is in a block relationship with the arriver hears nothing of the
   * arrival: not the live roster event, which reached them while the REST
   * roster did not (SCRUM-338).
   */
  const blockedIds = await blockCounterparties(userId)

  // Emit real-time check-in event: the pseudonym, except to whoever the
  // roster lets recognise them (the emitter decides, per recipient).
  emitEventCheckIn(
    eventId,
    userId,
    displayName,
    { name: arriver?.name ?? null, image: arriver?.profile?.photos?.[0] ?? null },
    blockedIds
  )

  /*
   * No push. Every arrival used to push "X just checked in!" to everybody
   * already inside, so the first person through the door heard about the
   * next two hundred. The live roster above is how the room sees arrivals.
   */

  return {
    checkIn,
    chatGroupId,
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
    /*
     * "Why do you go out?" — asked at the door of the first room, not at
     * sign-up (SCRUM-77). Onboarding never wrote `intent_default`, so every
     * account that came through it was refused the board for a field the
     * flow never asked for. True while there is no default and nothing was
     * chosen for this event; the app asks once and saves the answer as the
     * default, after which this is false at every later door. Re-checking
     * in to a room you already answered for does not ask again.
     */
    intentNeeded: (profile?.intent_default ?? []).length === 0 && prefs.intent.length === 0,
  }
}

async function createRoom(input: SeatInput, eventId: string): Promise<{ id: string }> {
  const { event } = input
  // A venue day's room is named for the venue: its title is bookkeeping.
  const roomName = event.kind === "venue_day" ? event.venue_name ?? "Live here" : `${event.title} Chat`
  try {
    return await db.chat_groups.create({
      data: {
        event_id: eventId,
        name: roomName,
        description: event.kind === "venue_day" ? `Live at ${roomName} today` : `Chat for ${event.title}`,
        status: "active",
        member_count: 0,
      },
      select: { id: true },
    })
  } catch (error) {
    if (!violatedConstraint(error, "chat_groups_event_id_key")) throw error
    return db.chat_groups.findUniqueOrThrow({ where: { event_id: eventId }, select: { id: true } })
  }
}

/**
 * Ensure the room exists and the person is in it, with a pseudonym.
 *
 * At a venue day the membership also carries the Go Live window as
 * `last_allowed_at` — the moment the room stops being theirs
 * (`liveInVenueDay`) — so it is rewritten on every Go Live, extending it.
 */
async function seatInRoom(input: SeatInput, eventId: string, now: Date): Promise<string> {
  const { userId, live } = input
  const cutOff = live?.expiresAt ?? null

  /*
   * Found, or made — and a lost race read back. This was a read then a create,
   * and the first two people through a door at the same moment both found no
   * room and both created one: the loser's check-in was a 500 on
   * `chat_groups_event_id_key`. Rare at an event's door; every first minute at
   * a busy venue on Go Live (PL-I01, driven by ten at once). Matched on the
   * constraint's name, never `meta.target`, which the driver adapter leaves
   * empty (memory: P2002 has no target here).
   */
  const chatGroup = (await db.chat_groups.findUnique({ where: { event_id: eventId }, select: { id: true } })) ?? (await createRoom(input, eventId))
  const chatGroupId = chatGroup.id

  const existingMembership = await db.chat_group_members.findUnique({
    where: { chat_group_id_user_id: { chat_group_id: chatGroupId, user_id: userId } },
  })

  /*
   * A ban a human applied survives a check-in.
   *
   * Rejoining set `status: "active"` on any non-active membership, so an
   * organiser's ban lasted exactly until the banned person walked out and
   * back in — the ban evaporated on the next check-in, the same shape as the
   * mute that cleared itself (G5). `banned_by` is the discriminator, as it
   * is for mutes: a human's ban has one, a suspension's does not, and the
   * suspension docstring promises re-entry through this door once lifted.
   * The check-in itself still stands — presence is a fact — the room stays
   * closed to them.
   */
  const humanBanned = existingMembership?.status === "banned" && Boolean(existingMembership.banned_by)
  if (existingMembership && humanBanned) {
    logger.info("Check-in kept a room ban", { userId, chatGroupId })
  } else if (existingMembership) {
    if (
      existingMembership.status !== "active" ||
      existingMembership.last_allowed_at ||
      !existingMembership.anonymous_name ||
      live
    ) {
      const rejoin = (anonymous_name: string) =>
        db.chat_group_members.update({
          where: { chat_group_id_user_id: { chat_group_id: chatGroupId, user_id: userId } },
          data: {
            status: "active",
            last_allowed_at: cutOff,
            // Checking in again is the way back into a room you left
            // yourself (`POST /chat/groups/:id/leave`).
            left_at: null,
            anonymous_name,
            updated_at: now,
          },
        })

      if (existingMembership.anonymous_name) {
        // They already have a handle; keep it. Re-minting would rename
        // somebody rejoining a room where people know them by that name.
        await rejoin(existingMembership.anonymous_name)
      } else {
        await claimAnonymousName(chatGroupId, rejoin, { eventId, userId })
      }
    }
  } else {
    await claimAnonymousName(
      chatGroupId,
      (anonymous_name) =>
        db.chat_group_members.create({
          data: {
            chat_group_id: chatGroupId,
            user_id: userId,
            role: "member",
            status: "active",
            last_allowed_at: cutOff,
            anonymous_name,
          },
        }),
      { eventId, userId }
    )

    await db.chat_groups.update({
      where: { id: chatGroupId },
      data: { member_count: { increment: 1 } },
    })
  }
  return chatGroupId
}
