import type { check_in_kind, check_in_status } from "@prisma/client"

/**
 * How many *people*, as opposed to how many rows.
 *
 * `event_check_ins` is `@@unique([occurrence_id, user_id])` — one row per person
 * **per day**, deliberately, so "who came on Wednesday" has an answer. The cost
 * is that `count()` on that table returns attendance-days, and eleven call sites
 * used it while saying "people".
 *
 * On a three-day conference every one of them read three times high. Concretely:
 *
 * - **Turn-up** is `min(attended, committed) / committed`, so a 1000-person
 *   three-day event produced 3000 attendances against 1000 RSVPs and the
 *   `min()` clamped it to exactly **100%** — the number looked perfect and was
 *   arithmetic.
 * - **No-show** is `100 − turn-up`, so it floored at **0%** and hid a real
 *   no-show problem behind a clamp.
 * - **"Came back for a 2nd event"** grouped by `user_id` and asked
 *   `_count._all > 1`. One person attending both days of one conference is two
 *   rows, so they counted as a returning attendee. **That tile did not measure
 *   what it was titled**, and it was the tile an organiser looks at to decide
 *   whether they are building an audience.
 *
 * `lib/attendance.ts` has always folded this correctly. This extracts the fold
 * so it can be unit-tested without Postgres — that module's coverage is an
 * integration suite that only runs in CI — and so every other caller has one
 * obvious thing to reach for.
 *
 * Pure on purpose: no `db` import, no clock. R18.
 */

/** The minimum shape any of these folds needs. */
export interface CheckInRow {
  user_id: string
  kind?: check_in_kind | null
  status?: check_in_status | null
}

/**
 * Statuses that mean somebody actually turned up.
 *
 * `checked_out` counts: they were here and left. `pending` and `cancelled` do
 * not.
 */
export const ATTENDED: check_in_status[] = ["checked_in", "checked_out"]

/**
 * Staff are excluded from every count here.
 *
 * They attend every day by definition, so including them turns "returning
 * attendees" into a headcount of the crew. Occupancy counts them, because fire
 * safety counts bodies; attendance does not, because they are not attendees.
 *
 * A null `kind` is treated as an attendee: the column was added after rows
 * already existed, and the backfill left history null.
 */
export function isAttendee(row: CheckInRow): boolean {
  return row.kind !== "staff"
}

/** Distinct people who turned up. The number nine call sites wanted. */
export function distinctAttendees(rows: readonly CheckInRow[]): number {
  return new Set(rows.filter(isAttendee).map((r) => r.user_id)).size
}

/**
 * People who attended more than one *event* — not more than one day.
 *
 * Takes rows already scoped to the events in question and grouped by event, so
 * the caller cannot accidentally hand it per-day rows and get the old answer.
 * The distinction is the whole point: `_count._all > 1` over raw rows counts a
 * two-day conference as two attendances by one person and calls them a repeat.
 */
export function repeatAttendees(
  rows: readonly (CheckInRow & { event_id: string })[]
): number {
  const eventsPerUser = new Map<string, Set<string>>()
  for (const row of rows) {
    if (!isAttendee(row)) continue
    const seen = eventsPerUser.get(row.user_id) ?? new Set<string>()
    seen.add(row.event_id)
    eventsPerUser.set(row.user_id, seen)
  }
  let repeats = 0
  for (const events of eventsPerUser.values()) if (events.size > 1) repeats++
  return repeats
}

/**
 * Turn-up, as a percentage, or null when nobody committed.
 *
 * Deliberately **not** clamped to 100. The clamp existed to stop no-show going
 * negative when row-counting inflated attendance, and it hid the one signal
 * that says an event outperformed its RSVPs: walk-ins. Counting people rather
 * than rows removes the reason for it, and an honest 130% is information.
 */
export function turnUpPct(attended: number, committed: number): number | null {
  if (committed === 0) return null
  return Math.round((attended / committed) * 100)
}

/**
 * No-show, as a percentage, or null when nobody committed.
 *
 * Floored at zero because more walk-ins than RSVPs is not a negative no-show —
 * it is zero no-shows and some extra people, and those are different facts.
 */
export function noShowPct(attended: number, committed: number): number | null {
  if (committed === 0) return null
  return Math.max(0, Math.round(((committed - attended) / committed) * 100))
}
