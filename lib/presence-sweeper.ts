// Relative imports: reachable from server.ts, and `build:server` compiles with
// plain tsc, which emits the @/ alias verbatim into the require().
import type { Prisma } from "@prisma/client"

import { ageFrom, minAgeRefusal } from "./age"
import { db } from "./db"
import { logger } from "./logger"
import { performCheckout } from "./checkout"
import { realEventsWhere, venueDaysWhere } from "./event-kind"
import { resolveFence, fenceSelect } from "./geofence"
import { evaluatePresence, type PresenceState } from "./presence"
import { sendBulkPushNotifications } from "./push-notifications"
import { hit } from "./rate-limit-store"
import { atTheVenue, takeoverSelect, venueTakeoverWhere } from "./venue-visibility"

/**
 * Close out people who have gone.
 *
 * Mirrors `lib/chat-lifecycle.ts` — same self-scheduling shape, same stop hook
 * in server.ts. A second scheduler would be a second thing to remember to start.
 *
 * The decision is not made here. `lib/presence.ts` decides, this applies. That
 * split is why every rule about noisy GPS is unit-testable without a database.
 */

export const SWEEP_INTERVAL_MS = 5 * 60 * 1000

/**
 * The share of one room the sweeper may close in a single pass.
 *
 * A venue whose wifi dies, or whose basement swallows GPS, produces a burst of
 * out-of-fence readings that look exactly like everyone leaving at once. Acting
 * on that would empty the room on the organiser's screen and read as an
 * evacuation.
 *
 * So past this share, the pass acts on **nobody** and raises an alert instead.
 * The organiser is told the count is unreliable rather than handed a wrong one,
 * which is the whole difference between a useful number and a dangerous one.
 *
 * 25% is a starting point, not a finding. Every trip is logged so the first
 * real event tells us the right number.
 */
export const MASS_CHECKOUT_THRESHOLD = 0.25

/**
 * How many departures it takes before "a lot at once" means anything.
 *
 * The share alone made auto-checkout **unreachable in a small room**. One
 * person leaving a room of two is 100%; one of three is 33%; both trip a 25%
 * threshold. So at a book club, a supper club, or the first hour of anything,
 * nobody was ever closed out and occupancy only climbed -- and at the end of
 * every event, when everyone leaves at once, the guard trips by construction
 * and the room never empties.
 *
 * The guard is about a **venue-wide signal failure**: wifi dying, a basement
 * swallowing GPS, a burst of out-of-fence readings that look exactly like an
 * evacuation. That is a phenomenon of crowds, and it cannot be inferred from
 * one person leaving a room of three.
 *
 * So both must hold: a large share, and enough people for a share to be
 * evidence. Five is the smallest number where "they all went outside at the
 * same moment" is more likely to be the venue than the people.
 */
export const MASS_CHECKOUT_FLOOR = 5

/**
 * How many events one pass may sweep.
 *
 * The query was `findMany({ where: { status: "checked_in" } })` -- **every open
 * check-in on the platform**, with no `take` and no scope, each row dragging the
 * event's geofence JSON and the venue's, every five minutes, on the Socket.io
 * event loop. It cost nothing at one event and grows without limit.
 *
 * The bound is on **events**, not rows, and that is not arbitrary: the
 * mass-checkout guard reasons about the share of a room that is leaving, so a
 * half-fetched event would compute that share against a partial denominator and
 * either trip on nothing or fail to trip on everything. A room is swept whole or
 * not at all.
 *
 * Oldest open check-in first, so the backlog drains in order rather than the
 * same rooms being swept forever while others are never reached. A swept room
 * closes its rows and drops out of the ordering by itself.
 *
 * 200 events every five minutes is far above any real night and far below
 * unbounded, which is the only property that matters here.
 */
export const MAX_EVENTS_PER_SWEEP = 200

export interface SweepResult {
  examined: number
  checkedOut: number
  /** Events where the guard tripped and nothing was done. */
  guarded: string[]
}

/**
 * Real events. Venue days have their own pass (`sweepVenueDays`) with its own
 * bound: every venue is live, so on a busy night there will be many more venue
 * days with someone in them than events, and sharing one oldest-first cap of
 * 200 would let them crowd the events out (F5).
 */
export async function sweepPresence(now: Date = new Date()): Promise<SweepResult> {
  return sweepRooms(realEventsWhere, MAX_EVENTS_PER_SWEEP, now)
}

/**
 * One pass over the rooms of one kind: departures by the fence, the day's end,
 * and the mass-checkout guard.
 */
async function sweepRooms(
  kind: Prisma.eventsWhereInput,
  cap: number,
  now: Date
): Promise<SweepResult> {
  const result: SweepResult = { examined: 0, checkedOut: 0, guarded: [] }

  /*
   * Which rooms, before which rows. See MAX_EVENTS_PER_SWEEP.
   *
   * `groupBy` on an indexed predicate returns one row per event rather than one
   * per attendee, so choosing the batch costs a fraction of fetching it.
   */
  const busiest = await db.event_check_ins.groupBy({
    by: ["event_id"],
    // any-kind: `kind` is realEventsWhere or venueDaysWhere, chosen by the pass that calls this.
    where: { status: "checked_in", event: kind },
    _min: { created_at: true },
    orderBy: { _min: { created_at: "asc" } },
    take: cap,
  })
  if (busiest.length === 0) return result

  if (busiest.length === cap) {
    // Not an error: the next pass picks up where this one stopped. Worth saying
    // out loud, because a permanently full batch means the sweeper is behind
    // and somebody is staying checked in longer than they should.
    logger.warn("Presence sweep hit its event cap", { cap, kind: kind.kind })
  }

  const open = await db.event_check_ins.findMany({
    where: {
      status: "checked_in",
      event_id: { in: busiest.map((b) => b.event_id) },
    },
    select: {
      id: true,
      event_id: true,
      user_id: true,
      kind: true,
      last_seen_at: true,
      left_area_at: true,
      occurrence: { select: { end_time: true } },
      event: { select: { ...fenceSelect } },
    },
  })
  result.examined = open.length
  if (open.length === 0) return result

  // Grouped so the guard can reason about a room rather than a person.
  const byEvent = new Map<string, typeof open>()
  for (const row of open) {
    byEvent.set(row.event_id, [...(byEvent.get(row.event_id) ?? []), row])
  }

  for (const [eventId, rows] of byEvent) {
    /*
     * One resolver. This consulted the event's fence and the venue's and never
     * `legacyGeofence`, so a pre-column event -- coordinates and a radius, no
     * geofence JSON -- was enforced at the door and by nothing afterwards. It
     * fell through to the "no geometry" branch below, where only the day ending
     * can close anybody out.
     */
    const fence = resolveFence(rows[0].event)

    const decisions = rows.map((row) => {
      const state: PresenceState = {
        kind: row.kind,
        leftAreaAt: row.left_area_at,
        lastSeenAt: row.last_seen_at,
      }
      // The sweeper never has a ping — it runs between them. Its job is the
      // passage of time: grace expiring, a prompt going unanswered, a day
      // ending. `evaluatePresence` treats a null ping as silence, which never
      // causes a mid-event checkout.
      return {
        row,
        decision: fence
          ? evaluatePresence(state, null, fence, row.occurrence.end_time, now)
          : // No fence at all: the only thing that can close them out is the
            // day ending, which is handled below without geometry.
            ({
              action:
                now.getTime() > row.occurrence.end_time.getTime() + 60 * 60_000
                  ? ("auto_checkout" as const)
                  : ("stay" as const),
              reason: "occurrence_ended" as const,
            }),
      }
    })

    const toCheckOut = decisions.filter((d) => d.decision.action === "auto_checkout")

    /*
     * The guard. Deliberately does not apply to `occurrence_ended` — a finished
     * event emptying its room is expected, not a signal, and refusing to close
     * it would leave every attendee checked in for ever.
     */
    const departures = toCheckOut.filter((d) => d.decision.reason !== "occurrence_ended")
    if (
      departures.length >= MASS_CHECKOUT_FLOOR &&
      departures.length / rows.length > MASS_CHECKOUT_THRESHOLD
    ) {
      result.guarded.push(eventId)
      logger.warn("Presence sweep guarded: too many departures at once", {
        eventId,
        wouldCheckOut: departures.length,
        inRoom: rows.length,
        threshold: MASS_CHECKOUT_THRESHOLD,
        floor: MASS_CHECKOUT_FLOOR,
        hint: "venue signal loss looks identical to everyone leaving; count is unreliable",
      })
      // Still close out anyone whose day simply ended.
      for (const d of toCheckOut.filter((x) => x.decision.reason === "occurrence_ended")) {
        const done = await performCheckout(d.row.id, "occurrence_ended", now)
        if (done?.changed) result.checkedOut++
      }
      continue
    }

    for (const { row, decision } of decisions) {
      switch (decision.action) {
        case "auto_checkout": {
          const done = await performCheckout(
            row.id,
            decision.reason === "occurrence_ended" ? "occurrence_ended" : "left_area",
            now
          )
          if (done?.changed) result.checkedOut++
          break
        }
        default:
          break
      }
    }
  }

  if (result.checkedOut > 0 || result.guarded.length > 0) {
    logger.info("Presence sweep", { ...result, guarded: result.guarded.join(",") })
  }
  return result
}

/* -------------------------------------------------------------------------- */
/* Venue days                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * How many Go Live windows one pass may expire, oldest end first.
 *
 * Its own bound, apart from the rooms' (F5): expiries are one indexed read
 * (`event_check_ins_expires_at_idx`, partial on `expires_at IS NOT NULL`) and
 * one checkout each, and a backlog drains in order of who should have gone
 * first. 500 every five minutes is a hundred a minute.
 */
export const MAX_EXPIRIES_PER_SWEEP = 500

/** How many venue days with someone live one pass may check, for the fence and for an event starting. */
export const MAX_VENUE_DAYS_PER_SWEEP = 200

export interface VenueDaySweepResult {
  /** Go Live windows that ran out (`expired`). Never counted by the guard (D-20). */
  expired: number
  /** Sessions closed because a real event started at the venue (`ended`). */
  closedForEvents: number
  /** People told that event started. One push each. */
  pushed: number
  /** The fence-and-guard pass over venue days, as for events. */
  rooms: SweepResult
}

/**
 * The venue-day pass: windows that ran out, venues a real event just took
 * over, and then the same fence-and-guard pass events get.
 *
 * Expiries first, and outside the guard. The mass-checkout guard exists for a
 * venue whose signal dies (a burst of out-of-fence readings that looks like
 * everyone leaving at once); twenty people whose 20-minute windows end in the
 * same five minutes are a schedule, not a signal, and holding them in the room
 * would keep people visible past the window they chose — the one promise Go
 * Live makes (D-20). Out-of-fence bursts on a venue day still trip it, in
 * `sweepRooms`.
 */
export async function sweepVenueDays(now: Date = new Date()): Promise<VenueDaySweepResult> {
  const expired = await expireWindows(now)
  const started = await closeForStartingEvents(now)
  const rooms = await sweepRooms(venueDaysWhere, MAX_VENUE_DAYS_PER_SWEEP, now)
  await forgetGoLiveCoordinates(now)
  const result = { expired, ...started, rooms }
  if (expired > 0 || started.closedForEvents > 0 || rooms.checkedOut > 0 || rooms.guarded.length > 0) {
    logger.info("Venue-day sweep", {
      expired,
      closedForEvents: started.closedForEvents,
      pushed: started.pushed,
      checkedOut: rooms.checkedOut,
      guarded: rooms.guarded.join(","),
    })
  }
  return result
}

/**
 * Every Go Live whose window has ended, checked out as `expired` at the
 * instant it ended (PL-U04) — so dwell is what was chosen, not what the
 * sweeper's timing added. A window open at the venue's reset ended at the
 * reset: Go Live never sets one past it (D-4).
 */
export async function expireWindows(now: Date = new Date()): Promise<number> {
  const due = await db.event_check_ins.findMany({
    where: { status: "checked_in", expires_at: { lte: now } },
    // `event_check_ins_status_expires_at_idx`: starts at the open windows.
    orderBy: { expires_at: "asc" },
    take: MAX_EXPIRIES_PER_SWEEP,
    select: { id: true, expires_at: true },
  })
  if (due.length === MAX_EXPIRIES_PER_SWEEP) {
    logger.warn("Venue-day sweep hit its expiry cap", { cap: MAX_EXPIRIES_PER_SWEEP })
  }
  let expired = 0
  for (const row of due) {
    const done = await performCheckout(row.id, "expired", row.expires_at!)
    if (done?.changed) expired++
  }
  return expired
}

/**
 * A real event has started at a venue: the people live there are closed out of
 * the venue's room (`ended`), and each is told once, by push, that the event
 * is on — "tap to check in".
 *
 * At the event's start, not an hour before. From an hour before, Go Live is
 * refused there with `EVENT_LIVE_HERE` (`venueTakeoverWhere`), so nobody new
 * joins; whoever is already live keeps the window they chose until the event
 * actually begins, and is then handed over to it. The push names the event
 * and the venue, never a person; the bell row is written for everybody and
 * the push goes only to devices whose owner allows it (`sendBulkPushNotifications`).
 * A private event takes nothing over (it is not `public`), so it closes
 * nothing and names itself to nobody. Somebody too young for the event's own
 * `min_age` keeps their session: Go Live was not refused to them either (D-3).
 *
 * One push per person because only the checkout that changed the row counts:
 * a second pass, or a second instance, finds them already out.
 */
async function closeForStartingEvents(now: Date): Promise<{ closedForEvents: number; pushed: number }> {
  /*
   * Only events on now at a venue where somebody is live: one bounded query,
   * not every event on the platform and a lookup each.
   */
  const starting = await db.events.findMany({
    where: {
      ...venueTakeoverWhere(now, { leadMinutes: 0 }),
      venue: { events: { some: { ...venueDaysWhere, check_ins: { some: { status: "checked_in" } } } } },
    },
    orderBy: { start_time: "asc" },
    take: MAX_VENUE_DAYS_PER_SWEEP,
    select: { ...takeoverSelect, min_age: true, venue: { select: { geofence: true } } },
  })
  if (starting.length === MAX_VENUE_DAYS_PER_SWEEP) {
    logger.warn("Venue-day sweep hit its event-start cap", { cap: MAX_VENUE_DAYS_PER_SWEEP })
  }

  let closedForEvents = 0
  let pushed = 0
  const handled = new Set<string>()
  for (const event of starting) {
    if (!event.venue_id || handled.has(event.venue_id)) continue
    // A link alone is not a takeover: confirmed, or the event's area at the venue (D-x3).
    if (!atTheVenue(event, event.venue?.geofence)) continue
    handled.add(event.venue_id)

    const live = await db.event_check_ins.findMany({
      where: { status: "checked_in", event: { ...venueDaysWhere, venue_id: event.venue_id } },
      take: MAX_CLOSED_PER_VENUE,
      select: { id: true, user: { select: { profile: { select: { age: true, date_of_birth: true } } } } },
    })
    const told: string[] = []
    for (const row of live) {
      // Not somebody the event's own age rule would turn away at its door
      // (D-3): their Go Live was allowed, and stays theirs.
      if (minAgeRefusal(ageFrom(row.user.profile), event.min_age)) continue
      const done = await performCheckout(row.id, "event_started", now)
      if (done?.changed) told.push(done.userId)
    }
    closedForEvents += told.length
    if (told.length === 0) continue

    /*
     * Words nobody but us wrote. The event's title and the venue's name are
     * typed by organisers, and a takeover pushes to everybody live at a venue
     * — a stranger's lock screen is the last place for text a stranger chose
     * (D-x3). The event is in `data`, so the tap opens it. And once per person
     * per event per window: two replicas closing the same room, or a second
     * event at the venue, never ring anybody twice.
     */
    const fresh: string[] = []
    for (const userId of new Set(told)) {
      if ((await hit(`takeover-push:${event.id}:${userId}`, TAKEOVER_PUSH_WINDOW_MS)).count === 1) fresh.push(userId)
    }
    if (fresh.length === 0) continue
    await sendBulkPushNotifications({
      userIds: fresh,
      title: "Blend'n",
      body: TAKEOVER_PUSH_BODY,
      data: { type: "event_update", eventId: event.id },
    }).catch((error) =>
      logger.warn("Event-start push failed", { eventId: event.id, error: error instanceof Error ? error.message : String(error) })
    )
    pushed += fresh.length
  }
  return { closedForEvents, pushed }
}

/** The push when an event takes a venue over: fixed words, no organiser's text (D-x3). */
export const TAKEOVER_PUSH_BODY = "An event just started here — tap to check in"

/** One takeover push per person per event in this long. */
export const TAKEOVER_PUSH_WINDOW_MS = 6 * 60 * 60_000

/** How many people one pass closes at one venue when an event starts there. */
export const MAX_CLOSED_PER_VENUE = 500

/** How long after a window ends its coordinates are kept. */
export const GO_LIVE_COORDINATES_DAYS = 3

/**
 * Where somebody stood when they went live is kept a few days — long enough
 * to look into a report or a fence that turned people away — then dropped
 * (step 4 review). Go Live rows only: `expires_at` is set on nothing else.
 * Bounded per pass, and only over the last month's windows, so the scan
 * never walks the whole history of rows already cleared.
 */
export async function forgetGoLiveCoordinates(now: Date = new Date()): Promise<number> {
  const before = new Date(now.getTime() - GO_LIVE_COORDINATES_DAYS * 24 * 3_600_000)
  const since = new Date(before.getTime() - 30 * 24 * 3_600_000)
  return db.$executeRaw`
    WITH old AS (
      SELECT id, occurrence_id, user_id FROM event_check_ins
       WHERE expires_at > ${since} AND expires_at < ${before}
         AND (latitude IS NOT NULL OR longitude IS NOT NULL)
       ORDER BY expires_at
       LIMIT 1000
    ), sessions AS (
      UPDATE presence_sessions ps
         SET last_lat = NULL, last_lng = NULL, last_accuracy = NULL
        FROM old
       WHERE ps.occurrence_id = old.occurrence_id AND ps.user_id = old.user_id
    )
    UPDATE event_check_ins c SET latitude = NULL, longitude = NULL FROM old WHERE c.id = old.id
  `
}

let timer: NodeJS.Timeout | null = null
let expiryTimer: NodeJS.Timeout | null = null

/** How often windows that ended are checked out, between the timers (`lib/live-timers.ts`). */
export const EXPIRY_INTERVAL_MS = 30_000

/**
 * Self-scheduling rather than `setInterval`, so a slow pass cannot overlap the
 * next one. Same reasoning as the chat lifecycle sweeper.
 *
 * Two loops. The five-minute one sweeps rooms: events, then venue days, each
 * in its own try so one failing never stops the other (F5). The thirty-second
 * one ends Go Live windows: each window schedules its own end, and this is
 * the backstop for the ones a restart or another replica lost — a window must
 * not outlive its end by five minutes (step 4 review).
 */
export function startPresenceSweeper(): void {
  if (timer) return
  const run = async () => {
    try {
      await sweepPresence()
    } catch (error) {
      // A sweep that throws must not take the process down or stop the loop.
      logger.error("Presence sweep failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
    // Its own try: one pass failing must not stop the other (venue days, F5).
    try {
      await sweepVenueDays()
    } catch (error) {
      logger.error("Venue-day sweep failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      timer = setTimeout(run, SWEEP_INTERVAL_MS)
    }
  }
  const expire = async () => {
    try {
      await expireWindows()
    } catch (error) {
      logger.error("Go Live expiry pass failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      expiryTimer = setTimeout(expire, EXPIRY_INTERVAL_MS)
    }
  }
  timer = setTimeout(run, SWEEP_INTERVAL_MS)
  expiryTimer = setTimeout(expire, EXPIRY_INTERVAL_MS)
}

export function stopPresenceSweeper(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (expiryTimer) {
    clearTimeout(expiryTimer)
    expiryTimer = null
  }
}
