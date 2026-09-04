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
  /*
   * Delegates to `headcount` rather than running its own query.
   *
   * It had one, and it was the same question with the same predicates — which
   * is how a codebase ends up with three answers to "who is inside" and an
   * audit section about it. One SQL statement owns the definition; this is a
   * projection of it.
   */
  const h = await headcount({ occurrenceId }, { now: opts.now })
  return opts.includeStaff ? h.insideGuests + h.insideStaff : h.insideGuests
}

/**
 * The heartbeat: move an open session's `last_seen_at` forward.
 *
 * `insideNow` counts a session only while `last_seen_at > cutoff`, and
 * `openSession` sets that field exactly once, at arrival. Without this, every
 * session goes stale PRESENCE_CUTOFF_MINUTES after check-in and occupancy
 * reads zero for a full room — the old model's opposite failure (rows that
 * never close) replaced by rooms that empty on a timer.
 *
 * Called from the same branch that persists the check-in ping, so the two
 * stores move together and the reconciliation between them stays meaningful.
 * `PING_INTERVAL_MINUTES` (5) throttles that branch and must stay below
 * `PRESENCE_CUTOFF_MINUTES` (10) or a live person drops out of the room
 * between writes; `__tests__/presence-timing.test.ts` fails the build if that
 * ordering is ever inverted.
 *
 * `updateMany` rather than `update`: the partial unique guarantees at most one
 * open session per person per occurrence, so this touches either one row or
 * none — and none is the correct no-op for somebody whose session the sweeper
 * has already closed.
 */
export async function touchSession(
  occurrenceId: string,
  userId: string,
  at: Date,
  fix?: { lat: number; lng: number; accuracy: number | null }
): Promise<void> {
  await db.presence_sessions.updateMany({
    where: { occurrence_id: occurrenceId, user_id: userId, departed_at: null },
    data: {
      last_seen_at: at,
      updated_at: at,
      ...(fix
        ? { last_lat: fix.lat, last_lng: fix.lng, last_accuracy: fix.accuracy }
        : {}),
    },
  })
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

/**
 * Inside now, split into guests and staff, for one occurrence or a whole run.
 *
 * The shape `getOccupancy` needs, and the reason the cutover cannot be done
 * without the counting fix in the same change.
 *
 * The old query was `event_check_ins.count(...)` — **rows**, not people. That
 * was accidentally right while scoped to one occurrence, because
 * `@@unique([occurrence_id, user_id])` made a row and a person the same thing.
 * It was already wrong in the event-wide fallback, where a multi-day run holds
 * a row per person per day and counting them told an organiser a three-day
 * conference had three times its attendance.
 *
 * Sessions remove the coincidence entirely: somebody who stepped out and came
 * back has several rows by design. Counting distinct users is not a
 * refinement here, it is the only correct reading.
 */
export interface Headcount {
  /** Distinct people inside right now, excluding staff. */
  insideGuests: number
  /** Distinct staff inside right now. */
  insideStaff: number
  /**
   * Of those inside, how many have not reported a position since the cutoff.
   *
   * Not subtracted from the counts above — they are still in the room until
   * something says otherwise. This is what lets a screen admit how much of its
   * own figure is inference rather than observation.
   */
  stale: number
  /** Distinct people who arrived at all, whether or not they are still here. */
  arrived: number
  /** Distinct people whose first arrival was inside the recent window. */
  arrivedRecently: number
}

/**
 * Every live number for one occurrence, in ONE query.
 *
 * The four counts below were four round trips on a screen that refreshes
 * every five seconds per watched event. Postgres computes all of them in a
 * single pass with `FILTER`, over one index — `@@index([occurrence_id,
 * departed_at])` — because they differ only by predicate.
 *
 * COUNT(DISTINCT user_id) throughout, never COUNT(*). With sessions a person
 * who steps out and comes back has several rows on purpose, so rows and
 * people are different questions and only one of them is ever being asked
 * here.
 *
 * `arrived` deliberately counts people who have since left: it is the
 * denominator for turn-up and for the leaving-early alert, both of which mean
 * "of everyone who came today". `arrivedRecently` is the arrival-rate
 * numerator and counts a person once, at their first arrival, so somebody
 * re-entering twice in ten minutes does not read as a queue at the door.
 */
export async function headcount(
  scope: { occurrenceId: string } | { eventId: string },
  opts: { now?: Date; recentMinutes?: number } = {}
): Promise<Headcount> {
  const now = opts.now ?? new Date()
  const cutoff = cutoffFrom(now)
  const since = new Date(now.getTime() - (opts.recentMinutes ?? 10) * 60_000)

  /*
   * Two scopes, one query. An occurrence is the live question — who is in the
   * room tonight — and the event-wide form is the fallback for a run between
   * days, which should report what is in the building rather than zero.
   *
   * A fragment rather than `(${id} IS NULL OR col = ${id})`: that form reads
   * as one tidy statement and stops Postgres using either index, on the query
   * that runs twelve times a minute per watched event.
   */
  const where =
    "occurrenceId" in scope
      ? Prisma.sql`occurrence_id = ${scope.occurrenceId}::uuid`
      : Prisma.sql`event_id = ${scope.eventId}::uuid`

  /*
   * INSIDE IS `departed_at IS NULL`, AND DELIBERATELY NOT `last_seen_at > cutoff`.
   *
   * This is the one decision in the cutover worth arguing, because both
   * answers are defensible and the codebase contained both:
   * `presence-sessions.itest.ts` asserted 45 minutes of silence empties a
   * room, and `presence-sweeper.itest.ts` asserted 240 minutes of it does not.
   * Neither test could see the other while `insideNow` had no callers and
   * `getOccupancy` read check-ins. Joining the two stores is what made them
   * collide.
   *
   * Silence loses. The Expo client refuses background location on purpose —
   * iOS `Always` permission is an App Review liability — so a phone in a
   * pocket stops reporting within minutes of the screen going off. Timing that
   * out would empty a full room, which is the original bug (occupancy that
   * only ever climbs) inverted rather than fixed, and inverted into the more
   * dangerous direction: a fire officer being told a full room is empty.
   *
   * A session ends when something DECIDES it ended — the person checks out,
   * the sweeper applies the client's tested policy (three consecutive outside
   * readings spanning ten minutes, then an allowance), or the occurrence
   * closes. Never because a packet did not arrive.
   *
   * `last_seen_at` keeps its job and loses its veto: `stale` counts people
   * inside whose position is older than the cutoff, so a screen can say how
   * much of its own number is inference. That is the honest form of the
   * liveness concern — report the doubt, do not silently resolve it by
   * deleting people from the room.
   */
  const [row] = await db.$queryRaw<
    {
      inside_guests: bigint
      inside_staff: bigint
      stale: bigint
      arrived: bigint
      arrived_recently: bigint
    }[]
  >`
    SELECT
      COUNT(DISTINCT user_id) FILTER (
        WHERE departed_at IS NULL AND kind = 'attendee'
      ) AS inside_guests,
      COUNT(DISTINCT user_id) FILTER (
        WHERE departed_at IS NULL AND kind = 'staff'
      ) AS inside_staff,
      COUNT(DISTINCT user_id) FILTER (
        WHERE departed_at IS NULL
          AND (last_seen_at IS NULL OR last_seen_at <= ${cutoff})
      ) AS stale,
      COUNT(DISTINCT user_id) AS arrived,
      COUNT(DISTINCT user_id) FILTER (WHERE arrived_at >= ${since}) AS arrived_recently
    FROM presence_sessions
    WHERE ${where}
  `

  return {
    insideGuests: Number(row?.inside_guests ?? 0),
    insideStaff: Number(row?.inside_staff ?? 0),
    stale: Number(row?.stale ?? 0),
    arrived: Number(row?.arrived ?? 0),
    arrivedRecently: Number(row?.arrived_recently ?? 0),
  }
}

