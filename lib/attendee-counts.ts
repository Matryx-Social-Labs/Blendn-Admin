import { Prisma } from "@prisma/client"
import { db } from "./db"
import { ATTENDED } from "./counting"
import { CONFIRMED_WINDOW_MINUTES } from "./presence"

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
 * Inside now, as `hereNow` says it — one predicate for the Room, the list
 * and the detail, and for the room's people (`GET /chat/groups/:id/participants`).
 * `hereNow` is raw SQL (a FILTER has no Prisma spelling) and writes this
 * predicate, and `inRoomWhere`'s, out by hand: `here-confirmed.itest.ts` holds
 * the two to one number.
 */
export const HERE_NOW = { status: "checked_in", kind: "attendee", user: { suspended_at: null } } as const

/**
 * The Room's headline numbers. `hereCount`: how many people are inside RIGHT
 * NOW. `hereConfirmed`: how many of them were seen, or checked in, within
 * `CONFIRMED_WINDOW_MINUTES` (SCRUM-1232) — never more than `hereCount`.
 */
export interface HereNow {
  hereCount: number
  hereConfirmed: number
}

const NOBODY_HERE: Readonly<HereNow> = Object.freeze({ hereCount: 0, hereConfirmed: 0 })

/**
 * `hereNow` for one event: the socket emitters, `room-preview`, the event
 * detail and the big-room moderation check.
 */
export async function hereNowFor(eventId: string): Promise<HereNow> {
  return (await hereNow([eventId])).get(eventId) ?? NOBODY_HERE
}

/**
 * The Room's numbers for a page of events in one read: the events list and the
 * Banter's room rows, so a card's "here now" is the Room's number and never
 * the attended one (`checkInCount`), which keeps everyone who has left.
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
 * At a venue day, a window still open (`inRoomWhere`), not the sweeper's lag
 * (SCRUM-922); a real event is unchanged.
 *
 * NOT a chat room's membership. A member row outlives the check-in (checkout
 * and expiry close the window, `last_allowed_at`, and leave the row `active` so
 * the room stays in the Banter as a past room), so a count of members is
 * everybody who was ever in and has not pressed Leave. `GET /chat/groups`
 * served that as "N in the room" and said 515 over a room of 483 (RC drive 3).
 *
 * `hereConfirmed` takes nobody out of `hereCount`: pings are foreground only,
 * so a silent phone is in a pocket as often as it went home, and emptying a
 * full room on a timer is the worse lie. It says how much of the number was
 * observed. A FILTER on the same rows, so the two can never disagree about who
 * is in the room, and it costs no second read.
 *
 * A COUNT in the database, never the rows: this runs on every arrival and
 * departure (the socket emitters), and a concert room is thousands of rows. One
 * row per person without a DISTINCT, because a person holds at most one
 * `checked_in` row anywhere (`event_check_ins_one_open_per_user`, SCRUM-705) —
 * a multi-day run's other days are closed rows. Served by
 * `event_check_ins(event_id, status)`.
 */
export async function hereNow(eventIds: readonly string[]): Promise<Map<string, HereNow>> {
  if (eventIds.length === 0) return new Map()
  const now = new Date()
  const since = new Date(now.getTime() - CONFIRMED_WINDOW_MINUTES * 60_000)
  // any-kind: a venue day's room counts too, while its window is open (inRoomWhere); a real event always.
  const rows = await db.$queryRaw<{ event_id: string; here: number; confirmed: number }[]>`
    SELECT c.event_id,
           COUNT(*)::int AS here,
           COUNT(*) FILTER (WHERE c.last_seen_at > ${since} OR c.check_in_time > ${since})::int AS confirmed
    FROM event_check_ins c
    JOIN "User" u ON u.id = c.user_id
    JOIN events e ON e.id = c.event_id
    WHERE c.event_id IN (${Prisma.join(eventIds)})
      AND c.status = 'checked_in'
      AND c.kind = 'attendee'
      AND u.suspended_at IS NULL
      AND (e.kind = 'event' OR c.expires_at > ${now})
    GROUP BY c.event_id
  `
  return new Map(rows.map((r) => [r.event_id, { hereCount: r.here, hereConfirmed: r.confirmed }]))
}

type CountRead = { running: Promise<HereNow>; next: Promise<HereNow> | null }
const countsInFlight = new Map<string, CountRead>()

/**
 * `hereNowFor` for the socket emitters, where a doors-open minute is dozens of
 * arrivals at once: calls that overlap share reads instead of making one each.
 * Never stale: a call joins only a read that STARTS after it was made, so the
 * count includes the write its caller just committed. At most two reads per
 * round however many callers (the one running, and one for everybody who came
 * while it ran).
 */
export function hereNowCoalesced(eventId: string): Promise<HereNow> {
  const inFlight = countsInFlight.get(eventId)
  if (!inFlight) return readHereNow(eventId)
  return (inFlight.next ??= inFlight.running.then(
    () => readHereNow(eventId),
    () => readHereNow(eventId)
  ))
}

function readHereNow(eventId: string): Promise<HereNow> {
  const read: CountRead = { running: hereNowFor(eventId), next: null }
  countsInFlight.set(eventId, read)
  const settled = () => {
    if (countsInFlight.get(eventId) === read) countsInFlight.delete(eventId)
  }
  read.running.then(settled, settled)
  return read.running
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
 * Ended or still running, by the event's `end_time` against `now`: the app's
 * "past" is `end_time < now`. The Blendn+ history gate counts and lists the
 * ended ones (`lib/plus.ts`), so its count and its free list share this one
 * predicate: a night still running is tonight, never one of the free slots.
 */
export type NightsWhen = { ended: boolean; now: Date }

function endedClause(when?: NightsWhen) {
  if (!when) return Prisma.empty
  // any-kind: narrows the caller's own predicate by the clock, and a person's places stay among their nights (D-6).
  return when.ended
    ? Prisma.sql`AND EXISTS (SELECT 1 FROM events e WHERE e.id = event_check_ins.event_id AND e.end_time < ${when.now})`
    : Prisma.sql`AND EXISTS (SELECT 1 FROM events e WHERE e.id = event_check_ins.event_id AND e.end_time >= ${when.now})`
}

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
  opts: { places: boolean; when?: NightsWhen } = { places: false }
): Promise<number> {
  const [row] = await db.$queryRaw<{ events: bigint }[]>`
    SELECT COUNT(DISTINCT event_id) AS events
    FROM event_check_ins
    WHERE user_id = ${userId}
      AND status::text IN (${Prisma.join(ATTENDED)})
      AND kind = 'attendee'
      ${opts.places ? LIVE_EVENT : LIVE_REAL_EVENT}
      ${endedClause(opts.when)}
  `
  return Number(row?.events ?? 0)
}

/**
 * Which of these people "came back": 2+ distinct real events, by `distinctEventsAttended`'s predicate, in one grouped
 * read. A room row's new / regular chip (D-030) — two values, so nobody can count anybody's nights from it.
 */
export async function regularsAmong(userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set()
  const rows = await db.$queryRaw<{ user_id: string }[]>`
    SELECT user_id
    FROM event_check_ins
    WHERE user_id = ANY(${userIds}::text[])
      AND status::text IN (${Prisma.join(ATTENDED)})
      AND kind = 'attendee'
      ${LIVE_REAL_EVENT}
    GROUP BY user_id
    HAVING COUNT(DISTINCT event_id) >= 2
  `
  return new Set(rows.map((r) => r.user_id))
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
  opts: { limit: number; skip: number; after?: { at: Date; id: string }; when?: NightsWhen }
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
        ${endedClause(opts.when)}
      ORDER BY event_id, COALESCE(check_in_time, created_at) ASC
    ) AS attended
    ${opts.after ? Prisma.sql`WHERE (first_seen, event_id) < (${opts.after.at}::timestamptz, ${opts.after.id}::uuid)` : Prisma.empty}
    ORDER BY first_seen DESC, event_id DESC
    LIMIT ${opts.limit} OFFSET ${opts.skip}
  `
}

/**
 * Distinct guests arriving per event per UTC hour, up to each night's settle
 * (`hostSettledAt`): the Check-ins export as a host has it (SCRUM-887). Counts,
 * never who; the caller floors each cell. A night not settled counts nothing.
 */
export async function arrivalsByHour(
  eventIds: readonly string[]
): Promise<Array<{ event_id: string; hour: string; arrivals: number }>> {
  if (eventIds.length === 0) return []
  return db.$queryRaw<Array<{ event_id: string; hour: string; arrivals: number }>>`
    SELECT c.event_id::text AS event_id,
           to_char(date_trunc('hour', c.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24":00Z"') AS hour,
           COUNT(DISTINCT c.user_id)::int AS arrivals
    FROM event_check_ins c
    -- any-kind: the caller's settled nights, by id; this only bounds them by their settle.
    JOIN events e ON e.id = c.event_id AND c.created_at <= e.host_settled_at
    WHERE c.event_id IN (${Prisma.join(eventIds)})
      AND c.status::text IN (${Prisma.join(ATTENDED)})
      AND c.kind = 'attendee'
    GROUP BY 1, 2
    ORDER BY 2
  `
}

/** How long after a night's last occurrence and last arrival it settles for its hosts. */
export const SETTLED_AFTER_MS = 2 * 60 * 60_000

/**
 * When each of these nights settled for its hosts (SCRUM-887), settling any
 * that now may. Absent: not settled, and a host gets no per-person list of it.
 *
 * Settles the first time every occurrence has ended AND nobody has checked in
 * for `SETTLED_AFTER_MS` -- the arrivals too, because the times are the host's
 * to edit. Written once (`events.host_settled_at`): only a row still NULL is
 * written, so concurrent readers cannot both write it and no later read moves
 * it. From then on a host's per-person views hold the check-ins up to it
 * (`checkedInBy`) and nothing after: a late arrival, or the host moving the
 * night's end, changes nothing they already saw.
 *
 * "Up to it" is the row's `created_at`, a person's first check-in to that day:
 * written on insert and never touched again, while a re-check-in moves
 * `check_in_time` (the upsert in lib/check-in-core.ts). Keyed on that, who is
 * in a settled night could change after it settled.
 */
export async function hostSettledAt(eventIds: readonly string[], now: Date = new Date()): Promise<Map<string, Date>> {
  if (eventIds.length === 0) return new Map()
  const before = new Date(now.getTime() - SETTLED_AFTER_MS)
  // any-kind: settles whichever nights a host list asked about; the caller's scope chose their kind.
  await db.$executeRaw`
    UPDATE events e SET host_settled_at = ${now}
    WHERE e.id IN (${Prisma.join(eventIds)})
      AND e.host_settled_at IS NULL
      AND COALESCE((SELECT MAX(o.end_time) FROM event_occurrences o WHERE o.event_id = e.id), e.end_time) <= ${before}
      AND COALESCE((SELECT MAX(COALESCE(c.check_in_time, c.created_at)) FROM event_check_ins c WHERE c.event_id = e.id AND c.kind = 'attendee'), '-infinity') <= ${before}
  `
  // any-kind: the same nights, read back by id.
  const rows = await db.events.findMany({
    where: { id: { in: [...eventIds] }, host_settled_at: { not: null } },
    select: { id: true, host_settled_at: true },
  })
  return new Map(rows.map((r) => [r.id, r.host_settled_at!]))
}

/** Check-ins of settled nights first made by the time each settled: what a host's per-person views hold. */
export function checkedInBy(settled: ReadonlyMap<string, Date>): Prisma.event_check_insWhereInput {
  return { OR: [...settled].map(([event_id, at]) => ({ event_id, created_at: { lte: at } })) }
}

/** `checkedInBy` for rows already read. */
export const arrivedBy = (settled: ReadonlyMap<string, Date>, row: { event_id: string; created_at: Date }) => {
  const at = settled.get(row.event_id)
  return at !== undefined && row.created_at <= at
}
