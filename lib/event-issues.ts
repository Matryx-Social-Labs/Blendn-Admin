// Relative imports: this runs from `lib/background.ts`, which `server.ts`
// requires, and `build:server` compiles with plain tsc — which emits the `@/`
// alias verbatim into the require() and fails at boot.
import { db } from "./db"
import { logger } from "./logger"
import { readLiveSnapshot } from "./live-snapshot"
import { deriveAlerts, type LiveAlert } from "./live-metrics"
import { realEventsWhere } from "./event-kind"

/**
 * Alerts, with a memory.
 *
 * `deriveAlerts` is pure, correct, and was called from exactly one place: a
 * `useMemo` in the live tab. Seven rules produced warnings that existed only
 * while somebody had that tab open, so an `over_capacity` breach at 23:40 was
 * gone at 23:45 with no record it had happened — on the screen a venue's
 * crowd-safety decisions are supposed to come from.
 *
 * The rule function is untouched. It simply has a second caller now, on a
 * timer, writing what it says into a table. Reusing it rather than
 * reimplementing it server-side is the whole point: two implementations of
 * "is this room in trouble" would eventually disagree, and the one nobody is
 * watching is the one that would be wrong.
 */

/**
 * How often the sweep runs.
 *
 * A minute, not five seconds. The ops broadcast already recomputes every five
 * for *watched* events; this exists for the unwatched ones, where the question
 * is "did this happen at all", not "what is the number right now". Every rule
 * here is minute-scale — a queue, a mood, a room going quiet — and a snapshot
 * per live event is several queries, so a tighter loop would cost real work to
 * answer a question nobody asked more precisely.
 */
const SWEEP_MS = 60_000

/**
 * Bounded, because "every live event" is unbounded by construction.
 *
 * A platform-wide sweep with no cap is the shape that made the presence
 * sweeper a problem: fine until the day it is not, and the failure arrives as
 * a slow query rather than an error.
 */
const MAX_EVENTS_PER_PASS = 200

let timer: NodeJS.Timeout | null = null
let running = false

/**
 * Events that are on right now, and therefore worth alerting about.
 *
 * No `ORDER BY … LIMIT` in the statement. With one, the planner walks
 * `(status, start_time)` in order, looking for the first 200 live events among
 * every published event that ever started -- found on a 300k-event history: 66 ms
 * and 300k rows filtered to return nine, every minute. Without it, `(status,
 * end_time)` reaches only what has not ended (5 ms). The live set is small by
 * nature; the order and the cap are applied here to the ids it returns.
 */
export async function liveEventIds(now: Date, max = MAX_EVENTS_PER_PASS): Promise<string[]> {
  const rows = await db.events.findMany({
    where: {
      deleted_at: null,
      // Alerts are for a host running a night. A venue day has none, and every
      // venue's would crowd real events out of the bound below (F5).
      ...realEventsWhere,
      status: "published",
      start_time: { lte: now },
      end_time: { gte: now },
    },
    select: { id: true, start_time: true },
  })
  return rows
    .sort((a, b) => a.start_time.getTime() - b.start_time.getTime())
    .slice(0, max)
    .map((r) => r.id)
}

/**
 * Record one event's alerts, and close the ones that have stopped firing.
 *
 * Exported for the test: the sweep around it is a timer, and the interesting
 * behaviour is what one pass does to one event.
 */
export async function recordIssuesFor(eventId: string, now: Date = new Date()): Promise<{
  opened: number
  stillOpen: number
  resolved: number
}> {
  // The snapshot's own reads of the event and its day, not a second set of them.
  const read = await readLiveSnapshot(eventId)
  if (!read) return { opened: 0, stillOpen: 0, resolved: 0 }
  const { snapshot, event, occurrenceId } = read

  const alerts: LiveAlert[] = deriveAlerts(snapshot, {
    scheduledEnd: event.end_time,
    scheduledStart: event.start_time ?? undefined,
    now,
  })
  const firing = new Set<string>(alerts.map((a) => a.kind))

  const open = await db.event_issues.findMany({
    where: { event_id: eventId, occurrence_id: occurrenceId, resolved_at: null },
    select: { id: true, kind: true },
  })
  const openByKind = new Map(open.map((o: { id: string; kind: string }) => [o.kind, o.id]))

  let opened = 0
  let stillOpen = 0
  for (const alert of alerts) {
    const existing = openByKind.get(alert.kind)
    if (existing) {
      /*
       * Bumped, not re-inserted. A queue lasting an hour is one issue with a
       * duration; sixty identical rows is a feed people scroll past.
       *
       * The wording is refreshed too — the body carries live numbers, and an
       * hour-old count is worse than no count.
       */
      await db.event_issues.update({
        where: { id: existing },
        data: { last_seen_at: now, severity: alert.severity, title: alert.title, body: alert.body },
      })
      stillOpen += 1
    } else {
      await db.event_issues.create({
        data: {
          event_id: eventId,
          occurrence_id: occurrenceId,
          kind: alert.kind,
          severity: alert.severity,
          title: alert.title,
          body: alert.body,
          opened_at: now,
          last_seen_at: now,
        },
      })
      opened += 1
    }
  }

  /*
   * Resolved means the CONDITION stopped, which is not the same as somebody
   * dealing with it — `acknowledged_at` is deliberately untouched here. An
   * alert that cleared itself and one a human acted on are different facts,
   * and the second is the one that gets asked about afterwards.
   */
  const stale = open.filter((o) => !firing.has(o.kind)).map((o) => o.id)
  if (stale.length) {
    await db.event_issues.updateMany({
      where: { id: { in: stale } },
      data: { resolved_at: now },
    })
  }

  return { opened, stillOpen, resolved: stale.length }
}

async function pass(): Promise<void> {
  const now = new Date()
  const ids = await liveEventIds(now)
  let opened = 0
  for (const id of ids) {
    try {
      const r = await recordIssuesFor(id, now)
      opened += r.opened
    } catch (error) {
      // One event's snapshot failing must not stop the rest of the pass.
      logger.warn("Issue sweep failed for event", {
        eventId: id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  if (opened > 0) logger.info("Live issues opened", { count: opened, events: ids.length })
}

/**
 * Self-scheduling, never `setInterval`.
 *
 * A pass is one query plus a snapshot per live event, and a slow one must not
 * overlap the next — `lib/socket-server.ts` carries the note about the ops
 * broadcast being the loop that got this wrong, and a structural test now bans
 * the pattern in `lib/`.
 */
export function startIssueSweeper(): void {
  if (timer) return
  const tick = async () => {
    if (running) return
    running = true
    try {
      await pass()
    } catch (error) {
      logger.error("Issue sweep failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      running = false
      if (timer) timer = setTimeout(tick, SWEEP_MS).unref()
    }
  }
  timer = setTimeout(tick, SWEEP_MS).unref()
}

export function stopIssueSweeper(): void {
  if (timer) clearTimeout(timer)
  timer = null
}

export interface IssueRow {
  id: string
  kind: string
  severity: string
  title: string
  body: string
  openedAt: string
  lastSeenAt: string
  resolvedAt: string | null
  acknowledgedAt: string | null
}

/**
 * What has happened at this event, whether or not anyone was watching.
 *
 * Open first, then recently resolved. A resolved issue is not deleted because
 * "the queue cleared itself twenty minutes ago" is the most useful thing this
 * table can tell somebody who has just walked in — and it is exactly what the
 * browser-only version could never say.
 */
export async function issuesFor(eventId: string, limit = 50): Promise<IssueRow[]> {
  const rows = await db.event_issues.findMany({
    where: { event_id: eventId },
    orderBy: [{ resolved_at: "asc" }, { opened_at: "desc" }],
    take: limit,
    select: {
      id: true,
      kind: true,
      severity: true,
      title: true,
      body: true,
      opened_at: true,
      last_seen_at: true,
      resolved_at: true,
      acknowledged_at: true,
    },
  })
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    severity: r.severity,
    title: r.title,
    body: r.body,
    openedAt: r.opened_at.toISOString(),
    lastSeenAt: r.last_seen_at.toISOString(),
    resolvedAt: r.resolved_at?.toISOString() ?? null,
    acknowledgedAt: r.acknowledged_at?.toISOString() ?? null,
  }))
}
