// Relative, not `@/`: this module is reachable from `server.ts`, which is
// compiled by plain `tsc` in `build:server` and cannot resolve the alias.
// `__tests__/server-import-boundary.test.ts` fails the build otherwise — it
// caught exactly this when the file was first added.
import { logger } from "./logger"
import { db } from "./db"

/**
 * Nothing pruned `notifications`, ever.
 *
 * ```
 *   every push ──> notifications row ──> ...forever
 * ```
 *
 * There was no retention job, no TTL, no cron. Rows left only when the user
 * tapped CLEAR or deleted their account. A busy attendee accumulated one per
 * DM, per room message, per check-in, indefinitely — and until the change that
 * ships alongside this file, each one carried a copy of what somebody wrote.
 *
 * Two windows rather than one, because a read notification and an unread one
 * are different objects. An unread row is still doing its job: it is the thing
 * in the bell somebody has not looked at yet, and deleting it loses information
 * the user never received. A read row has already been consumed — it is history,
 * and history is what storage limitation is about.
 *
 * Deliberately not configurable. A retention period that can be set per
 * deployment is one that will be set to "never" on the first support ticket.
 */
export const READ_RETENTION_DAYS = 30
export const UNREAD_RETENTION_DAYS = 90

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6 hours
const BATCH_LIMIT = 5_000

let sweepTimer: ReturnType<typeof setTimeout> | null = null

function daysAgo(days: number, now: Date): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
}

/**
 * Delete notifications past their window. Returns how many went.
 *
 * Bounded per pass. A first run against a table that has never been pruned
 * could otherwise be a single unbounded delete over years of rows, taking locks
 * on a table that every bell read touches. Six-hourly passes drain it instead,
 * and the caller can see from the return value whether a backlog remains.
 *
 * Idempotent: the predicates are absolute timestamps, so a second pass in the
 * same window deletes nothing.
 */
export async function pruneNotifications(now: Date = new Date()): Promise<number> {
  const stale = await db.notifications.findMany({
    where: {
      OR: [
        { read_at: { not: null, lt: daysAgo(READ_RETENTION_DAYS, now) } },
        { read_at: null, created_at: { lt: daysAgo(UNREAD_RETENTION_DAYS, now) } },
      ],
    },
    select: { id: true },
    take: BATCH_LIMIT,
  })

  if (stale.length === 0) return 0

  const { count } = await db.notifications.deleteMany({
    where: { id: { in: stale.map((n) => n.id) } },
  })
  return count
}

async function runSweep(): Promise<void> {
  try {
    const deleted = await pruneNotifications()
    if (deleted > 0) {
      logger.info("Pruned notifications", { deleted, hadMore: deleted === BATCH_LIMIT })
    }
  } catch (error) {
    logger.error("Notification prune failed", { error: String(error) })
  }
}

/**
 * Start the sweeper. Runs once immediately, then on an interval.
 *
 * Same shape as `startChatLifecycleSweeper`, and for the same reason: deploys
 * restart this process regularly, so boot is when any backlog gets cleared.
 */
/*
 * Self-scheduling, not `setInterval` — and this file is why the reconciliation
 * exists rather than either branch.
 *
 * #265 wrote it with `setInterval`; #282 banned that pattern across `lib/`
 * because a slow pass and a fixed interval eventually overlap. Neither PR could
 * see the conflict: the guard did not exist on #265's base, and this file did
 * not exist on #282's.
 *
 * It is also the sweeper *most* able to outlast its own interval. It deletes in
 * batches of 5,000 and takes locks on `notifications`, a table every read of the
 * notification bell touches — so a second pass starting on top of the first
 * would queue behind its own locks and make the stall worse.
 *
 * `finally`, not the end of `try`: a throw must still reschedule, or one failed
 * sweep retires the loop for the life of the process.
 */
let stopped = false

export function startNotificationRetentionSweeper(): void {
  if (sweepTimer) return
  stopped = false

  const schedule = () => {
    if (stopped) return
    sweepTimer = setTimeout(() => {
      void (async () => {
        try {
          await runSweep()
        } finally {
          schedule()
        }
      })()
    }, SWEEP_INTERVAL_MS)
    sweepTimer.unref?.()
  }

  void (async () => {
    try {
      await runSweep()
    } finally {
      schedule()
    }
  })()
}

export function stopNotificationRetentionSweeper(): void {
  stopped = true
  if (sweepTimer) {
    clearTimeout(sweepTimer)
    sweepTimer = null
  }
}
