// Relative imports: the Live tab's "Crews tonight" (lib/live-social.ts) is read from server.ts.
import { Prisma } from "@prisma/client"

import { db } from "../db"

/*
 * A night's crews as counts (S8, crews board 07-hosts A): the peak, the Mixes
 * and the crews that came back. Counts only: no crew, member or pair leaves
 * here, and every reader floors them (`lib/disclosure.ts`).
 *
 * Who is in a crew is read now, as `insightCountsOf` reads the crews that came:
 * nothing about a crew's past members is recorded. A dissolved crew, and one a
 * moderator hid, counts for nobody (C12).
 */

/** The most crews here at one moment, the people in them then, and when, to ten minutes. */
export interface CrewPeak {
  crews: number
  people: number
  at: string
}

/** "At 22:40", not at the second somebody's friend walked in. */
const PEAK_STEP_MS = 10 * 60_000

const roundedDown = (at: Date) => new Date(Math.floor(at.getTime() / PEAK_STEP_MS) * PEAK_STEP_MS).toISOString()

/**
 * The peak, from the presence sessions of one event (every day of a run) or of
 * one day. A crew is here while two or more of its members are, as it is live
 * (`presentMembersAt`), so it is the sum of every crew's two-or-more stretches.
 *
 * A person's sessions are merged first (`range_agg`), so one person is never
 * two members; a session that began and ended at once is empty and drops out.
 * Null when no crew was ever here.
 */
export async function crewPeak(where: { eventId: string } | { occurrenceId: string }): Promise<CrewPeak | null> {
  const scope = "occurrenceId" in where ? Prisma.sql`p.occurrence_id = ${where.occurrenceId}::uuid` : Prisma.sql`p.event_id = ${where.eventId}::uuid`
  const [row] = await db.$queryRaw<{ at: Date; crews: bigint; people: bigint }[]>`
    WITH stay AS MATERIALIZED (
      SELECT m.crew_id, p.user_id, unnest(range_agg(tstzrange(p.arrived_at, CASE WHEN p.departed_at > p.arrived_at THEN p.departed_at WHEN p.departed_at IS NOT NULL THEN p.arrived_at END))) AS r
        FROM presence_sessions p
        JOIN crew_members m ON m.user_id = p.user_id
        JOIN crews k ON k.id = m.crew_id AND k.dissolved_at IS NULL AND k.hidden_at IS NULL
       WHERE ${scope} AND p.kind = 'attendee'
       GROUP BY m.crew_id, p.user_id
    ),
    step AS (
      SELECT crew_id, t, sum(sum(d)) OVER (PARTITION BY crew_id ORDER BY t) AS n
        FROM (SELECT crew_id, lower(r) AS t, 1 AS d FROM stay
              UNION ALL
              SELECT crew_id, upper(r), -1 FROM stay WHERE NOT upper_inf(r)) e
       GROUP BY crew_id, t
    ),
    crossing AS (
      SELECT t, (n >= 2)::int - COALESCE(lag(n) OVER (PARTITION BY crew_id ORDER BY t) >= 2, false)::int AS d FROM step
    ),
    peak AS (
      SELECT t, sum(sum(d)) OVER (ORDER BY t) AS crews FROM crossing GROUP BY t ORDER BY crews DESC, t ASC LIMIT 1
    )
    SELECT peak.t AS at, peak.crews,
           (SELECT count(DISTINCT user_id) FROM stay
             WHERE r @> peak.t
               AND crew_id IN (SELECT crew_id FROM stay WHERE r @> peak.t GROUP BY crew_id HAVING count(*) >= 2)) AS people
      FROM peak
     WHERE peak.crews > 0`
  return row ? { crews: Number(row.crews), people: Number(row.people), at: roundedDown(row.at) } : null
}

/** Mixes made: two crews matched, or a crew and one more, whether they are still open or not. */
export async function mixesMade(where: { eventId: string } | { occurrenceId: string }): Promise<number> {
  return db.blends.count({ where: "occurrenceId" in where ? { occurrence_id: where.occurrenceId } : { occurrence: { event_id: where.eventId } } })
}

/**
 * Of the crews that came, the ones two or more of whose members had come
 * together to an earlier night by the same host, and the people in them. The
 * host is the event's organisation, or, on a venue day, the venue, since it
 * was claimed (nothing from before a claim, ruling 2026-09-27). Null: nobody's
 * earlier nights to compare with (an event with no organisation).
 *
 * A member counts for an earlier night only if they were in the crew by its end.
 */
export async function crewsBack(eventId: string): Promise<{ crews: number; people: number } | null> {
  // any-kind: a venue day's earlier nights are its venue's, an event's its organisation's.
  const event = await db.events.findUnique({
    where: { id: eventId },
    select: { kind: true, start_time: true, organizer_org_id: true, venue_id: true, venue: { select: { claimed_at: true } } },
  })
  if (!event) return null
  const day = event.kind === "venue_day"
  const claimedAt = event.venue?.claimed_at
  if (day ? !event.venue_id || !claimedAt : !event.organizer_org_id) return null
  const sameHost = day
    ? Prisma.sql`e.kind = 'venue_day' AND e.venue_id = ${event.venue_id}::uuid AND e.start_time >= ${claimedAt}`
    : Prisma.sql`e.kind = 'event' AND e.organizer_org_id = ${event.organizer_org_id}::uuid`
  const [row] = await db.$queryRaw<{ crews: bigint; people: bigint }[]>`
    WITH tonight AS MATERIALIZED (
      SELECT m.crew_id, m.user_id, m.joined_at
        FROM crew_members m JOIN crews k ON k.id = m.crew_id AND k.dissolved_at IS NULL AND k.hidden_at IS NULL
       WHERE m.user_id IN (SELECT user_id FROM event_check_ins
                            WHERE event_id = ${eventId}::uuid AND check_in_time IS NOT NULL AND kind = 'attendee')
    ),
    came AS (SELECT crew_id FROM tonight GROUP BY crew_id HAVING count(*) >= 2),
    back AS (
      SELECT DISTINCT q.crew_id FROM (
        SELECT m.crew_id
          FROM crew_members m
          JOIN event_check_ins c ON c.user_id = m.user_id AND c.check_in_time IS NOT NULL AND c.kind = 'attendee'
          JOIN events e ON e.id = c.event_id
         WHERE m.crew_id IN (SELECT crew_id FROM came)
           AND e.deleted_at IS NULL AND e.start_time < ${event.start_time} AND e.id <> ${eventId}::uuid
           AND m.joined_at <= e.end_time AND ${sameHost}
         GROUP BY m.crew_id, e.id
        HAVING count(DISTINCT m.user_id) >= 2) q
    )
    SELECT (SELECT count(*) FROM back) AS crews,
           (SELECT count(DISTINCT user_id) FROM tonight WHERE crew_id IN (SELECT crew_id FROM back)) AS people`
  return { crews: Number(row?.crews ?? 0), people: Number(row?.people ?? 0) }
}
