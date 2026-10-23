import { Prisma } from "@prisma/client"
import { db } from "./db"
import { ATTENDED } from "./counting"

/**
 * How many *people* attended each of these events.
 *
 * The impure half of `lib/counting.ts`. That module folds rows you already
 * hold; this one answers the same question for a **list** of events without
 * pulling every row, which is what the CSV export, the mobile feed and the
 * venue detail page all need.
 *
 * ## Why `_count` cannot do this
 *
 * `event_check_ins` is `@@unique([occurrence_id, user_id])` — one row per
 * person **per day** — and Prisma's `_count` has no `DISTINCT`. So every
 * `_count.check_ins` in the codebase returns attendance-days while its label
 * says people, and on a three-day conference it reads three times high.
 *
 * ## Four predicates, one question
 *
 * The call sites this replaces disagreed about what "attended" means:
 *
 * | Site | Asked |
 * |---|---|
 * | `lib/reports.ts` | `status IN (checked_in, checked_out)` |
 * | `lib/services/events.service.ts` | `status = checked_in` — so leaving *un*-attended you |
 * | `app/dashboard/venues/[id]` | `status IN ATTENDED` |
 * | `lib/attendance.ts` | `check_in_time IS NOT NULL` |
 *
 * The second is the one worth naming: the mobile feed's `checkInCount` dropped
 * anyone who had checked out, so an event's headline number went *down* as the
 * night went on. This module asks `ATTENDED`, once, for everybody.
 *
 * ## Staff are excluded
 *
 * They attend every day by definition. `kind` is `@default(attendee)` and NOT
 * NULL, so `kind = 'attendee'` is exact — the same predicate `lib/attendance.ts`
 * has always used.
 */
export async function distinctAttendeeCounts(
  eventIds: readonly string[]
): Promise<Map<string, number>> {
  if (eventIds.length === 0) return new Map()

  const rows = await db.$queryRaw<{ event_id: string; people: bigint }[]>`
    SELECT event_id, COUNT(DISTINCT user_id) AS people
    FROM event_check_ins
    WHERE event_id IN (${Prisma.join(eventIds)})
      AND status::text IN (${Prisma.join(ATTENDED)})
      AND kind = 'attendee'
    GROUP BY event_id
  `

  // Absent rather than zero for an event nobody attended — callers read through
  // `?? 0`, and a map that only holds the events with attendance is the honest
  // shape of a GROUP BY.
  return new Map(rows.map((r) => [r.event_id, Number(r.people)]))
}

/**
 * How many people attended each of these days — `event_occurrences` rows.
 *
 * `distinctAttendeeCounts`'s question, grouped by the day rather than the
 * event. The venue owner's check-ins export reads it: guests per event per day,
 * never who (SCRUM-501).
 */
export async function distinctAttendeeCountsByDay(
  occurrenceIds: readonly string[]
): Promise<Map<string, number>> {
  if (occurrenceIds.length === 0) return new Map()

  const rows = await db.$queryRaw<{ occurrence_id: string; people: bigint }[]>`
    SELECT occurrence_id, COUNT(DISTINCT user_id) AS people
    FROM event_check_ins
    WHERE occurrence_id IN (${Prisma.join(occurrenceIds)})
      AND status::text IN (${Prisma.join(ATTENDED)})
      AND kind = 'attendee'
    GROUP BY occurrence_id
  `
  return new Map(rows.map((r) => [r.occurrence_id, Number(r.people)]))
}

/**
 * Inside now, as `hereCountFor` says it — one predicate for the Room, the list
 * and the detail, and for the room's people (`GET /chat/groups/:id/participants`).
 */
export const HERE_NOW = { status: "checked_in", kind: "attendee", user: { suspended_at: null } } as const

/**
 * The Room's headline number: how many people are inside RIGHT NOW.
 *
 * Deliberately NOT `distinctAttendeeCounts`. That is "attended" — it keeps
 * `checked_out` so an event's headline stops falling as the night goes on, and
 * `GET /events/:id` still serves it as `checkInCount`. The Room is the other
 * question: who is here now, so a checkout has to make this go down.
 *
 * `checked_in` only, attendees only (staff are working, as everywhere else),
 * and no suspended account — suspension bans the chat membership but leaves
 * the check-in row, and a person who cannot enter the room should not be
 * counted in it. "Show online status" off is still counted: the roster's rule
 * is "in the room, counted, not listed" (SCRUM-141), and a count names nobody.
 *
 * NOT a chat room's membership. A member row outlives the check-in (checkout
 * and expiry close the window, `last_allowed_at`, and leave the row `active` so
 * the room stays in the Banter as a past room), so a count of members is
 * everybody who was ever in and has not pressed Leave. `GET /chat/groups`
 * served that as "N in the room" and said 515 over a room of 483 (RC drive 3).
 *
 * A COUNT in the database, never the rows: this runs on every arrival and
 * departure (the socket emitters), and a concert room is thousands of rows. One
 * row per person without a DISTINCT, because a person holds at most one
 * `checked_in` row anywhere (`event_check_ins_one_open_per_user`, SCRUM-705) —
 * a multi-day run's other days are closed rows. Served by
 * `event_check_ins(event_id, status)`.
 *
 * Read by the socket emitters (`hereCount`), `room-preview`, the events list
 * and detail, and the Banter's room rows (`hereCount`, through `hereCounts`).
 */
export async function hereCountFor(eventId: string): Promise<number> {
  return db.event_check_ins.count({ where: { event_id: eventId, ...HERE_NOW } })
}

/**
 * `hereCountFor` for a page of events in one read: the events list's
 * `hereCount`, so a card's "here now" is the Room's number and never the
 * attended one (`checkInCount`), which keeps everyone who has left. A GROUP BY,
 * one row per event, for the reason above.
 */
export async function hereCounts(eventIds: readonly string[]): Promise<Map<string, number>> {
  if (eventIds.length === 0) return new Map()
  const rows = await db.event_check_ins.groupBy({
    by: ["event_id"],
    where: { event_id: { in: [...eventIds] }, ...HERE_NOW },
    _count: { _all: true },
  })
  return new Map(rows.map((r) => [r.event_id, r._count._all]))
}

/**
 * An event the platform deleted is out of the count and the list alike
 * (SCRUM-432). The count used to keep it while the list dropped it after its
 * LIMIT, so a profile said 3 above a list of 1, and a page whose newest event
 * was deleted came back short. Both queries below take this.
 */
// any-kind: a person's own nights out, the places they went live at included and
// labelled as places (D-6). The count and the list share it, so they agree.
const LIVE_EVENT = Prisma.sql`
  AND EXISTS (SELECT 1 FROM events e WHERE e.id = event_check_ins.event_id AND e.deleted_at IS NULL)
`

/** `LIVE_EVENT`, real events only: what anybody but the person sees of them. */
const LIVE_REAL_EVENT = Prisma.sql`
  AND EXISTS (SELECT 1 FROM events e WHERE e.id = event_check_ins.event_id AND e.deleted_at IS NULL AND e.kind = 'event')
`

/**
 * How many distinct *events* this person has attended.
 *
 * `_count.event_check_ins` on a user counts attendance-days, so somebody whose
 * only outing was a three-day conference was told they had attended three
 * events. It is rendered to the user as "events attended" on their own profile.
 */
export async function distinctEventsAttended(
  userId: string,
  /**
   * Whether the places they went live at count (D-6). Yes for their own
   * profile and `/me/attendance`, whose list includes them; never for anybody
   * else's view of them — how many venue days somebody has is a trail of where
   * they go out, for nothing a stranger needs (step 4 review).
   */
  opts: { places: boolean } = { places: false }
): Promise<number> {
  const [row] = await db.$queryRaw<{ events: bigint }[]>`
    SELECT COUNT(DISTINCT event_id) AS events
    FROM event_check_ins
    WHERE user_id = ${userId}
      AND status::text IN (${Prisma.join(ATTENDED)})
      AND kind = 'attendee'
      ${opts.places ? LIVE_EVENT : LIVE_REAL_EVENT}
  `
  return Number(row?.events ?? 0)
}


/**
 * *Which* events this person has attended, most recent first.
 *
 * Deliberately next to `distinctEventsAttended` and sharing its predicate. The
 * count is rendered on a profile and this is the list behind it, so the two
 * answering differently is the exact failure this module exists to prevent —
 * "you attended 7 events" above a list of 9 is worse than either number alone,
 * because it makes the user distrust both.
 *
 * `DISTINCT ON` rather than a group-by, because a multi-day event gives one
 * person a check-in row per day and the useful timestamp is the **first** one:
 * when they arrived at that event, not when they last turned up to it. Ordering
 * inside `DISTINCT ON` picks that row; the outer ordering is what the caller
 * reads.
 */
export async function attendedEventIds(
  userId: string,
  opts: { limit: number; skip: number; after?: { at: Date; id: string } }
): Promise<Array<{ event_id: string; first_seen: Date }>> {
  return db.$queryRaw<Array<{ event_id: string; first_seen: Date }>>`
    SELECT event_id, first_seen FROM (
      SELECT DISTINCT ON (event_id)
             event_id,
             COALESCE(check_in_time, created_at) AS first_seen
      FROM event_check_ins
      WHERE user_id = ${userId}
        AND status::text IN (${Prisma.join(ATTENDED)})
        AND kind = 'attendee'
        ${LIVE_EVENT}
      ORDER BY event_id, COALESCE(check_in_time, created_at) ASC
    ) AS attended
    ${opts.after ? Prisma.sql`WHERE (first_seen, event_id) < (${opts.after.at}::timestamptz, ${opts.after.id}::uuid)` : Prisma.empty}
    ORDER BY first_seen DESC, event_id DESC
    LIMIT ${opts.limit} OFFSET ${opts.skip}
  `
}
