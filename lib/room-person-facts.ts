import { Prisma } from "@prisma/client"

import { ageBand, bandsShown, type AgeBand } from "@/lib/age"
import { regularsAmong } from "@/lib/attendee-counts"
import { ATTENDED } from "@/lib/counting"
import { db } from "@/lib/db"
import { operatesEvent } from "@/lib/tonight"

/**
 * What a room row may say about somebody before they reveal (D-030, SCRUM-1384): a wide age band and a new / regular
 * chip, and nothing else — no exact age, no city, no join date, no counts. In a room of 20, age plus city plus tenure
 * names people. Every room surface takes both from here: the roster (`/matches`), the night's people, `/checkins`,
 * the room card on `/users/:id` and `/profiles/:id`, and your own "See as others do".
 *
 * - `ageBand`: null unless `AGE_BAND_FLOOR` people who ever checked in at this event as attendees share it. That
 *   population is the same for every viewer and every route and only grows, so comparing two routes, or two
 *   viewers, shows nothing one of them does not. Ages are taken at the event's start, so a birthday flips no row.
 *   Null too with no event (a crew's, Blend's or post's room: no population to hide in) and for an unknown age.
 * - `tenure`: "regular" once they came back (2+ distinct real events, `regularsAmong`), else "new". One bit.
 * - Somebody who operates the event gets neither (`operatesEvent`): hosts see totals only. `viewerId` null is your
 *   own card, which that rule does not touch.
 */
export interface RoomPersonFacts {
  ageBand: AgeBand | null
  tenure: "new" | "regular" | null
}

const NO_FACTS: RoomPersonFacts = { ageBand: null, tenure: null }

export async function roomPersonFacts(
  viewerId: string | null,
  eventId: string | null,
  userIds: string[]
): Promise<Map<string, RoomPersonFacts>> {
  // All three at once: a roster page waits on the database in one wave more, not two (roster-scope.itest.ts).
  const [operates, bands, regulars] = await Promise.all([
    viewerId && eventId ? operatesEvent(viewerId, eventId) : false,
    eventId ? bandsAt(eventId, userIds) : new Map<string, AgeBand>(),
    regularsAmong(userIds),
  ])
  if (operates) return new Map(userIds.map((id) => [id, NO_FACTS]))
  return new Map(userIds.map((id) => [id, { ageBand: bands.get(id) ?? null, tenure: regulars.has(id) ? "regular" : "new" }]))
}

/**
 * The bands of these people that the event's attendees share `AGE_BAND_FLOOR` deep: one read, an age histogram of
 * the event (a few dozen rows however big the room) with the asked-for ids beside their age. The SQL age is
 * `ageFrom`'s, taken at the event's start rather than now: the birth date in UTC when it is plausible, else the
 * stored age.
 */
async function bandsAt(eventId: string, userIds: string[]): Promise<Map<string, AgeBand>> {
  if (userIds.length === 0) return new Map()
  // ponytail: one scan of the event's attendee check-ins per page and per card. Indexed on event_id; the answer is
  // the same for every viewer, so cache it per event (short TTL) if a concert room shows up in the query times.
  const histogram = await db.$queryRaw<{ age: number; people: number; targets: string[] | null }[]>`
    WITH room AS (
      SELECT DISTINCT user_id FROM event_check_ins
       WHERE event_id = ${eventId}::uuid AND kind = 'attendee' AND status::text IN (${Prisma.join(ATTENDED)})
    ), aged AS (
      SELECT r.user_id, COALESCE(CASE WHEN y.years BETWEEN 0 AND 149 THEN y.years END, p.age) AS age
        FROM room r
        -- any-kind: only this room's own start time, to take ages at; a venue day's room bands its people the same way.
        JOIN events e ON e.id = ${eventId}::uuid
        LEFT JOIN profiles p ON p.id = r.user_id
        CROSS JOIN LATERAL (
          SELECT date_part('year', age(timezone('UTC', e.start_time)::date, p.date_of_birth))::int AS years
        ) y
    )
    SELECT age, COUNT(*)::int AS people, array_agg(user_id) FILTER (WHERE user_id = ANY(${userIds}::text[])) AS targets
      FROM aged
     WHERE age IS NOT NULL
     GROUP BY age`
  const shown = bandsShown(histogram)
  return new Map(
    histogram.flatMap(({ age, targets }) => {
      const band = ageBand(age)
      return band && shown.has(band) ? (targets ?? []).map((id) => [id, band] as const) : []
    })
  )
}
