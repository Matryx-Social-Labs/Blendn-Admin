// Relative imports: this is reachable from server.ts, which is compiled by
// plain tsc and would emit the @/ alias verbatim into the require(). See
// v0.12.1 — that mistake built green and killed the container on boot.
import { db } from "./db"
import { logger } from "./logger"
import { CHAT_WINDOW_HOURS } from "./chat-window"

/** Bounded so one pass cannot hold locks for an unbounded period. */
const SWEEP_BATCH = 500
/**
 * Every 15 minutes.
 *
 * Deliberately coarse. The write gate already refuses posts to an expired room
 * on the strength of the event's own `end_time`, so this job is not what stops
 * anyone typing — it tidies state. Lateness is therefore unobservable, and
 * paying for precision would mean per-event timers with four kinds of
 * bookkeeping (reschedule on edit, cancel on delete, rehydrate on boot, dedupe
 * across replicas) to buy something nobody can perceive.
 */
export const SWEEP_INTERVAL_MS = 15 * 60 * 1000

export interface SweepResult {
  archived: number
  released: number
  hasMore: boolean
}

/**
 * Archive chatrooms whose feedback window has closed and release their members.
 *
 * Idempotent by construction: both writes are `updateMany` filtered on the
 * state they are leaving, so a second pass matches nothing. That is what makes
 * it safe to run from every replica without coordination, and safe to trigger
 * manually while the timer is also running.
 */
export async function sweepExpiredChats(): Promise<SweepResult> {
  const cutoff = new Date(Date.now() - CHAT_WINDOW_HOURS * 60 * 60 * 1000)

  const expired = await db.chat_groups.findMany({
    where: {
      status: "active",
      event: { end_time: { lt: cutoff } },
    },
    select: { id: true },
    take: SWEEP_BATCH,
  })

  if (expired.length === 0) return { archived: 0, released: 0, hasMore: false }

  const ids = expired.map((group) => group.id)

  const [archived, released] = await db.$transaction([
    db.chat_groups.updateMany({
      /*
       * `status: "active"` is the half the docstring above already claims.
       *
       * It said "both writes are `updateMany` filtered on the state they are
       * leaving", and this one was filtered on the id alone. Two replicas
       * selecting the same batch would both write it and both report having
       * archived it, so the count was rooms *selected* rather than rooms
       * *changed* -- and the idempotence the comment rests on was true of the
       * members write and asserted of this one.
       */
      where: { id: { in: ids }, status: "active" },
      data: { status: "archived" },
    }),
    /*
     * Members are marked `left`, not deleted. `anonymous_name` lives on the
     * membership row and every historical message resolves its pseudonym
     * through it — deleting would strip the names off the whole transcript,
     * which anonymises nobody and breaks the feedback digest.
     *
     * Banned members keep that status: a ban is a moderation record and should
     * outlive the room closing.
     */
    db.chat_group_members.updateMany({
      where: { chat_group_id: { in: ids }, status: { in: ["active", "muted"] } },
      data: { status: "left" },
    }),
  ])

  return {
    // What changed, not what was selected.
    archived: archived.count,
    released: released.count,
    hasMore: expired.length === SWEEP_BATCH,
  }
}

/* -------------------------------------------------------------------------- */

let sweepTimer: ReturnType<typeof setInterval> | null = null

async function runSweep(): Promise<void> {
  try {
    const result = await sweepExpiredChats()
    if (result.archived > 0) logger.info("Archived expired chat groups", { ...result })
  } catch (error) {
    // Must never escape: this runs on a timer inside the same process as
    // Socket.io, and an unhandled rejection here would take the server down
    // — losing every open connection to tidy up some rows.
    logger.error("Chat lifecycle sweep failed", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Start the sweeper. Runs once immediately, then on an interval.
 *
 * The immediate pass matters more than the interval: deploys restart this
 * process regularly, so boot is when the backlog from any downtime gets
 * cleared. Mirrors how `SponsoredMessageScheduler` rehydrates on start.
 */
export function startChatLifecycleSweeper(): void {
  if (sweepTimer) return
  void runSweep()
  sweepTimer = setInterval(() => void runSweep(), SWEEP_INTERVAL_MS)
  // Do not hold the event loop open on its own account — a process with
  // nothing else to do should still be able to exit, which also keeps jest
  // from hanging if this is ever started in a test.
  sweepTimer.unref?.()
}

export function stopChatLifecycleSweeper(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
}
