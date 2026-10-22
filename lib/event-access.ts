// Relative imports — see lib/conversations.ts. Enforced by
// __tests__/server-import-boundary.test.ts.
import { ageFrom, FINISH_ONBOARDING, mayParticipate, minAgeRefusal } from "./age"
import { ErrorCode, errorResponse, notFoundResponse } from "./api-response"
import { db } from "./db"
import { canJoinEvent } from "./socket-auth"

/**
 * The host is not suspended (SCRUM-8). A suspended organisation's published
 * events are flipped to `draft`, so every attendee surface already hides
 * them; this fragment is for the ONE dashboard clause that reads by creator
 * rather than by status — the `organizer_id` fallback in `visibleEventsWhere`
 * and its twins — so a member of a suspended org does not see a list full of
 * rows that do not open. A legacy event with no org passes.
 */
export const hostNotSuspended = {
  OR: [{ organizer_org_id: null }, { organizer_org: { status: { not: "suspended" as const } } }],
}

/**
 * May this attendee act on ONE event — open it, RSVP, save it, read its board?
 *
 * Discovery (`GET /events`) applied these rules on its own and the door
 * (`/checkin`) applied the status and age halves — never visibility, until
 * SCRUM-147; every other single-event route applied none. So a draft, a
 * stranger's private event and an 18+ event were all reachable by id — a deep
 * link opened them in full, and a 17-year-old could RSVP, favourite and read
 * the board of a `min_age 18` event while the feed hid it (SCRUM-130). A draft
 * could be RSVP'd to, which SCRUM-13 had closed for the feed only.
 *
 * Two answers, shaped like the two rules they mirror:
 *
 * - `not_found` for a draft or a private event the viewer is not part of —
 *   the same answer discovery gives, so an id is not a way to learn that an
 *   unannounced event exists. `canJoinEvent` is the private-event rule the
 *   socket room already enforces: the organiser, or an RSVP.
 * - `age` for an under-age viewer, with `minAgeRefusal`'s copy, so the client
 *   can say why rather than "not found" — the event is real and they know it.
 *
 * `intent` decides what an UNKNOWN age means. Discovery shows restricted events
 * to an account without an age (OAuth accounts start without one; failing
 * closed would empty their feed), and the door refuses them. `view` keeps the
 * first posture; `participate` keeps the second, because an RSVP, a save or a
 * board read is the beginning of being there.
 */
export type EventAccessDenial =
  | { kind: "not_found"; reason?: typeof ErrorCode.ORGANISER_SUSPENDED }
  | { kind: "age"; message: string; unknownAge: boolean }
  | { kind: "unfinished"; message: string }

/*
 * `participate` also asks `mayParticipate` (SCRUM-331): finished onboarding, or
 * an adult age on file. It is asked before the event's own age rule because it
 * is about the person, not the event, and it holds everywhere.
 */
export async function attendeeEventAccess(
  userId: string,
  eventId: string,
  intent: "view" | "participate"
): Promise<EventAccessDenial | null> {
  const event = await db.events.findUnique({
    where: { id: eventId, deleted_at: null },
    select: { status: true, visibility: true, min_age: true, kind: true, pre_suspension_status: true, organizer_id: true, organizer_org_id: true },
  })
  /*
   * A venue day is not an event anybody opens, RSVPs to, saves or reads the
   * board of: it is `unlisted`, not `private`, so without this its id passed
   * every rule below. Its one door is Go Live (`POST /venues/:id/live`), and
   * its room's own routes check being live (`liveInVenueDay`, `inRoomWhere`).
   */
  if (!event || event.status === "draft" || event.kind === "venue_day") {
    return { kind: "not_found", ...(await suspensionReasonFor(userId, eventId, event)) }
  }
  if (event.visibility === "private" && !(await canJoinEvent(userId, eventId))) {
    return { kind: "not_found" }
  }
  if (event.min_age == null && intent === "view") return null

  const profile = await db.profiles.findUnique({
    where: { id: userId },
    select: { age: true, date_of_birth: true, onboarded: true },
  })
  if (intent === "participate" && !mayParticipate(profile)) {
    return { kind: "unfinished", message: FINISH_ONBOARDING }
  }
  if (event.min_age == null) return null
  // Derived, never the stored column — see `ageFrom` in lib/age.ts.
  const age = ageFrom(profile)
  if (age == null && intent === "view") return null
  const message = minAgeRefusal(age, event.min_age)
  return message ? { kind: "age", message, unknownAge: age == null } : null
}

type SuspensionCandidate = { status: string; kind: string; pre_suspension_status: string | null; organizer_id: string; organizer_org_id: string | null }

/**
 * `{ reason: ORGANISER_SUSPENDED }` for an event that was live and is hidden
 * because its organisation was suspended, said to the people who have a stake
 * in it; `{}` for everyone else and for every other reason an event is not there.
 *
 * A draft that was published until its organisation was suspended says so; a
 * draft nobody announced does not. Said only to somebody who said they were
 * going (or maybe, or is waitlisted — anything but `not_going`), and the
 * organisation that runs it. A stranger, and somebody who declined, get the
 * plain 404 a hidden event gives: for a private event the reason would also
 * tell a stranger holding the id that it exists. (`canJoinEvent` cannot be the
 * question: it answers no for any draft, and this is one.)
 *
 * The organisation is read from its members directly. `actorFor` leaves a
 * suspended organisation's memberships out, which is the point of suspending
 * it, and so cannot tell us whose event this was.
 *
 * `event` is the row the caller already has, or `undefined` to have it read: the
 * routes that refuse a hidden event for their own reasons (the door, the guest
 * list, the chat, the crews) ask here, on the refusal path only, so every one
 * of them gives the app the same `reasonCode` the event's own page does.
 */
export async function suspensionReasonFor(
  userId: string,
  eventId: string,
  event?: SuspensionCandidate | null
): Promise<{ reason?: typeof ErrorCode.ORGANISER_SUSPENDED }> {
  const row =
    event !== undefined
      ? event
      : await db.events.findUnique({
          where: { id: eventId, deleted_at: null },
          select: { status: true, kind: true, pre_suspension_status: true, organizer_id: true, organizer_org_id: true },
        })
  const suspended = row?.status === "draft" && row.kind !== "venue_day" && row.pre_suspension_status !== null
  if (!row || !suspended) return {}
  return (await hasStakeInSuspendedEvent(userId, eventId, row.organizer_id, row.organizer_org_id)) ? { reason: ErrorCode.ORGANISER_SUSPENDED } : {}
}

/** The 404 a route gives for an event that is not there for this person, `reasonCode` included when there is one. */
export async function eventNotFoundResponse(userId: string, eventId: string, message = "Event not found") {
  const { reason } = await suspensionReasonFor(userId, eventId)
  return reason ? errorResponse(message, 404, ErrorCode.NOT_FOUND, reason) : notFoundResponse(message)
}

async function hasStakeInSuspendedEvent(userId: string, eventId: string, organizerId: string, orgId: string | null): Promise<boolean> {
  if (organizerId === userId) return true
  const [rsvp, member] = await Promise.all([
    db.event_rsvps.findFirst({ where: { event_id: eventId, user_id: userId, status: { not: "not_going" } }, select: { id: true } }),
    orgId ? db.organisation_members.findFirst({ where: { org_id: orgId, user_id: userId }, select: { user_id: true } }) : null,
  ])
  return rsvp !== null || member !== null
}

/**
 * The same rule for the surfaces that are not about one event — starting a
 * conversation, a message request, a DM (SCRUM-331). The sentence, or `null`.
 */
export async function participationRefusal(userId: string): Promise<string | null> {
  const profile = await db.profiles.findUnique({
    where: { id: userId },
    select: { age: true, date_of_birth: true, onboarded: true },
  })
  return mayParticipate(profile) ? null : FINISH_ONBOARDING
}

/**
 * The 403 for `participationRefusal`'s sentence: `FORBIDDEN` and the words as
 * they always were, and `reasonCode: PROFILE_INCOMPLETE` beside them (Flow 15).
 */
export const unfinishedResponse = (sentence: string) =>
  errorResponse(sentence, 403, ErrorCode.FORBIDDEN, ErrorCode.PROFILE_INCOMPLETE)

/** The denial as the response every guarded route returns for it. */
export function eventAccessResponse(denial: EventAccessDenial) {
  if (denial.kind === "age") {
    return errorResponse(
      denial.message,
      403,
      ErrorCode.AGE_RESTRICTED,
      // Too young is the code it always was, said in the new field too, so the app reads one place.
      denial.unknownAge ? ErrorCode.AGE_UNKNOWN : ErrorCode.AGE_RESTRICTED
    )
  }
  if (denial.kind === "unfinished") return unfinishedResponse(denial.message)
  return denial.reason ? errorResponse("Event not found", 404, ErrorCode.NOT_FOUND, denial.reason) : notFoundResponse("Event not found")
}
