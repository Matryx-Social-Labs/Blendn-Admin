import { Prisma } from "@prisma/client"

// Relative, not "@/lib/db", for the reason `lib/checkout.ts` documents at
// length: `build:server` compiles with plain tsc, which resolves the @/ alias
// for typechecking and emits it verbatim into the require(). The build goes
// green and the container dies on boot with MODULE_NOT_FOUND. This module is
// reachable from server.ts through the presence sweeper, so the rule applies.
import { db } from "./db"

/**
 * Presence, asked once.
 *
 * `event_check_ins` answers "is this person here" with a mutable status on a
 * single row per person per occurrence. This module answers it with sessions,
 * and the difference is not stylistic: **stepping outside and coming back is
 * unrepresentable in the old shape**, because the re-entry would have to
 * overwrite the arrival.
 *
 * Everything here is a fold over rows. There is no counter, so the drift that
 * `events.current_capacity` demonstrates — a number three surfaces render and
 * nothing maintains — cannot occur.
 *
 * ## The one thing to know before adding a query
 *
 * "Inside now" is `departed_at IS NULL AND last_seen_at > cutoff`, and the
 * cutoff half is not optional. A session with no departure is not evidence of
 * presence — it is evidence that nothing closed it, which is exactly what a
 * stalled sweeper produces. Occupancy climbing forever is the bug this replaces
 * (C3, I8); asking only `departed_at IS NULL` rebuilds it in a new table.
 */

/** How long silence is tolerated before somebody stops counting as present. */
export const PRESENCE_CUTOFF_MINUTES = 10

export const cutoffFrom = (now: Date = new Date()): Date =>
  new Date(now.getTime() - PRESENCE_CUTOFF_MINUTES * 60_000)

export interface ArrivalInput {
  eventId: string
  occurrenceId: string
  userId: string
  kind?: "attendee" | "staff"
  at?: Date
  lat?: number | null
  lng?: number | null
  accuracy?: number | null
  source?: "os_geofence" | "polling"
}

/**
 * Somebody arrived — idempotent by construction.
 *
 * If a session is already open for this pair the existing one is returned and
 * its heartbeat refreshed, rather than a second being opened. That is enforced
 * by a partial unique in the migration (`WHERE departed_at IS NULL`) as well as
 * checked here, because a race between two check-in requests would otherwise
 * open two sessions and occupancy would count one body twice.
 *
 * Belt and braces on purpose: the check makes the ordinary path cheap and
 * readable, the index makes the concurrent path impossible.
 */
export async function openSession(input: ArrivalInput) {
  const at = input.at ?? new Date()

  const existing = await db.presence_sessions.findFirst({
    where: { occurrence_id: input.occurrenceId, user_id: input.userId, departed_at: null },
    select: { id: true },
  })

  if (existing) {
    return db.presence_sessions.update({
      where: { id: existing.id },
      data: {
        last_seen_at: at,
        ...(input.lat != null && { last_lat: input.lat }),
        ...(input.lng != null && { last_lng: input.lng }),
        ...(input.accuracy != null && { last_accuracy: input.accuracy }),
        updated_at: at,
      },
    })
  }

  return db.presence_sessions.create({
    data: {
      event_id: input.eventId,
      occurrence_id: input.occurrenceId,
      user_id: input.userId,
      kind: input.kind ?? "attendee",
      arrived_at: at,
      last_seen_at: at,
      ...(input.lat != null && { last_lat: input.lat }),
      ...(input.lng != null && { last_lng: input.lng }),
      ...(input.accuracy != null && { last_accuracy: input.accuracy }),
      source: input.source ?? "polling",
    },
  })
}

/**
 * Somebody left, and how we know.
 *
 * `source` is stored rather than inferred because it is what lets a soft number
 * say it is soft: an occurrence whose sessions mostly closed by `sweeper` — on
 * silence, rather than on a definite signal — is degraded, and the organiser's
 * screen should say so instead of presenting a confident figure.
 *
 * Returns the number of sessions closed, which is 0 when they were not inside.
 * That is not an error: a checkout arriving twice, or after the sweeper already
 * closed the session, is ordinary.
 */
export async function closeSession(
  occurrenceId: string,
  userId: string,
  source: "user" | "sweeper" | "switch" | "ended" | "expired",
  at: Date = new Date()
): Promise<number> {
  const { count } = await db.presence_sessions.updateMany({
    where: { occurrence_id: occurrenceId, user_id: userId, departed_at: null },
    data: { departed_at: at, departed_source: source, updated_at: at },
  })
  return count
}

/**
 * How many distinct people are inside this occurrence right now.
 *
 * `DISTINCT` is belt-and-braces, and worth being honest about: while the
 * partial unique holds — one OPEN session per person per occurrence — it is
 * provably equivalent to `COUNT(*)`, because the rows this filter returns are
 * already one per person. A recorded control swapping it for `COUNT(*)` broke
 * nothing, which is the mutation being invalid rather than the test being weak.
 *
 * It stays for the case where the index does not: a `db push` database has no
 * partial unique, because `schema.prisma` cannot express one. There the two are
 * not equivalent, and counting rows would put somebody who stepped out and came
 * back into the room twice — the row-versus-person error (I1) arriving in the
 * table built to remove it.
 */
export async function insideNow(
  occurrenceId: string,
  opts: { now?: Date; includeStaff?: boolean } = {}
): Promise<number> {
  const now = opts.now ?? new Date()
  const [row] = await db.$queryRaw<{ people: bigint }[]>`
    SELECT COUNT(DISTINCT user_id) AS people
    FROM presence_sessions
    WHERE occurrence_id = ${occurrenceId}::uuid
      AND departed_at IS NULL
      AND last_seen_at > ${cutoffFrom(now)}
      ${opts.includeStaff ? Prisma.empty : Prisma.sql`AND kind = 'attendee'`}
  `
  return Number(row?.people ?? 0)
}

/**
 * Total time inside, excluding time spent outside.
 *
 * The reason dwell needs sessions at all: with one mutable row, "how long were
 * they here" can only be `check_out_time - check_in_time`, which counts the
 * hour they spent at the pub in the middle. Summing closed sessions does not.
 *
 * Open sessions are excluded rather than counted up to now — a dwell figure
 * that grows while you look at it is a different measurement, and mixing the
 * two silently is how a number stops meaning one thing.
 */
export async function dwellSeconds(occurrenceId: string, userId: string): Promise<number> {
  const [row] = await db.$queryRaw<{ seconds: number | null }[]>`
    SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (departed_at - arrived_at))), 0)::float AS seconds
    FROM presence_sessions
    WHERE occurrence_id = ${occurrenceId}::uuid
      AND user_id = ${userId}
      AND departed_at IS NOT NULL
  `
  return Math.round(row?.seconds ?? 0)
}

/**
 * Did this person attend at all — any session, open or closed.
 *
 * Deliberately not "are they inside": somebody who came and left attended.
 * `lib/attendee-counts.ts` draws the same distinction for the old table and the
 * two must keep agreeing while both exist.
 */
export async function attended(occurrenceId: string, userId: string): Promise<boolean> {
  const found = await db.presence_sessions.findFirst({
    where: { occurrence_id: occurrenceId, user_id: userId },
    select: { id: true },
  })
  return found !== null
}

/**
 * How confident the occupancy figure is.
 *
 * An occurrence whose sessions mostly closed on silence rather than on a
 * definite signal is degraded, and R31 says the organiser's screen must say so.
 * A number nobody can trust should announce that where it is shown, rather than
 * looking exactly like one that can be.
 */
export async function departureQuality(occurrenceId: string): Promise<{
  closed: number
  bySweeper: number
  degraded: boolean
}> {
  const rows = await db.presence_sessions.groupBy({
    by: ["departed_source"],
    where: { occurrence_id: occurrenceId, departed_at: { not: null } },
    _count: { _all: true },
  })
  /*
   * Unknown-source sessions are excluded from the ratio, not counted as
   * definite signals.
   *
   * Backfilled history has `departed_source` NULL: the old row recorded *that*
   * somebody left and never *how*, because with one mutable row there was
   * nothing to attribute. Counting those as non-sweeper would make every
   * occurrence that predates sessions look confidently measured, when it was
   * not measured at all — which is the opposite of what this function is for.
   */
  const attributed = rows.filter((r) => r.departed_source !== null)
  const closed = attributed.reduce((n, r) => n + r._count._all, 0)
  const bySweeper = attributed.find((r) => r.departed_source === "sweeper")?._count._all ?? 0
  // Half is the line: below it the sweeper is tidying up after a few people who
  // walked out without checking out, which is normal. Above it, the figure is
  // mostly inference.
  return { closed, bySweeper, degraded: closed > 0 && bySweeper / closed > 0.5 }
}
