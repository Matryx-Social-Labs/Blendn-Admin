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

let sweepTimer: ReturnType<typeof setInterval> | null = null

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
export function startNotificationRetentionSweeper(): void {
  if (sweepTimer) return
  void runSweep()
  sweepTimer = setInterval(() => void runSweep(), SWEEP_INTERVAL_MS)
  sweepTimer.unref?.()
}

export function stopNotificationRetentionSweeper(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
}
