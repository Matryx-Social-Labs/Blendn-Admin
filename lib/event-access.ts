// Relative imports — see lib/conversations.ts. Enforced by
// __tests__/server-import-boundary.test.ts.
import { ageFrom, minAgeRefusal } from "./age"
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
  | { kind: "not_found" }
  | { kind: "age"; message: string }

export async function attendeeEventAccess(
  userId: string,
  eventId: string,
  intent: "view" | "participate"
): Promise<EventAccessDenial | null> {
  const event = await db.events.findUnique({
    where: { id: eventId, deleted_at: null },
    select: { status: true, visibility: true, min_age: true },
  })
  if (!event || event.status === "draft") return { kind: "not_found" }
  if (event.visibility === "private" && !(await canJoinEvent(userId, eventId))) {
    return { kind: "not_found" }
  }
  if (event.min_age == null) return null

  const profile = await db.profiles.findUnique({
    where: { id: userId },
    select: { age: true, date_of_birth: true },
  })
  // Derived, never the stored column — see `ageFrom` in lib/age.ts.
  const age = ageFrom(profile)
  if (age == null && intent === "view") return null
  const message = minAgeRefusal(age, event.min_age)
  return message ? { kind: "age", message } : null
}

/** The denial as the response every guarded route returns for it. */
export function eventAccessResponse(denial: EventAccessDenial) {
  return denial.kind === "age"
    ? errorResponse(denial.message, 403, ErrorCode.AGE_RESTRICTED)
    : notFoundResponse("Event not found")
}
