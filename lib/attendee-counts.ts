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
 * How many distinct *events* this person has attended.
 *
 * `_count.event_check_ins` on a user counts attendance-days, so somebody whose
 * only outing was a three-day conference was told they had attended three
 * events. It is rendered to the user as "events attended" on their own profile.
 */
export async function distinctEventsAttended(userId: string): Promise<number> {
  const [row] = await db.$queryRaw<{ events: bigint }[]>`
    SELECT COUNT(DISTINCT event_id) AS events
    FROM event_check_ins
    WHERE user_id = ${userId}
      AND status::text IN (${Prisma.join(ATTENDED)})
      AND kind = 'attendee'
  `
  return Number(row?.events ?? 0)
}
