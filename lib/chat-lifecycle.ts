// Relative imports: this is reachable from server.ts, which is compiled by
// plain tsc and would emit the @/ alias verbatim into the require(). See
// v0.12.1 — that mistake built green and killed the container on boot.
import { db } from "./db"
import { logger } from "./logger"
import { CHAT_WINDOW_HOURS } from "./chat-window"
import { OWNER_ROOM_HOURS } from "./room-kind"
import { closeRoomSockets } from "./room-close"

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
  const now = Date.now()
  const cutoff = new Date(now - CHAT_WINDOW_HOURS * 60 * 60 * 1000)

  const expired = await db.chat_groups.findMany({
    where: {
      status: "active",
      // An event's room closes on its event's clock; another kind's on its owner's (below).
      kind: "event",
      // any-kind: every room closes the same way once its event is over; a venue day's ends at its reset.
      event: { end_time: { lt: cutoff } },
    },
    select: { id: true },
    take: SWEEP_BATCH,
  })

  /*
   * A board post's room closes `OWNER_ROOM_HOURS` after the post's event ends
   * (E2), and a Blend's at its `closes_at` (the occurrence's end + the same
   * twelve hours) or when a block across its sides closed it early. Their
   * doors already refuse on the clock (`roomWindowFor`, `roomOwnerDenial`);
   * this archives them, releases their members and takes their sockets out
   * (E3). A crew's room never closes on a clock.
   */
  const ownerExpired = await db.chat_groups.findMany({
    where: {
      status: "active",
      kind: "board_post",
      // any-kind: a post's room closes on its post's night, whatever kind of event it was.
      board_post: { event: { end_time: { lt: new Date(now - OWNER_ROOM_HOURS * 60 * 60 * 1000) } } },
    },
    select: { id: true },
    take: SWEEP_BATCH,
  })
  const blendsOver = await db.chat_groups.findMany({
    where: {
      status: "active",
      kind: "blend",
      blend: { OR: [{ closes_at: { lte: new Date(now) } }, { closed_at: { not: null } }] },
    },
    select: { id: true },
    take: SWEEP_BATCH,
  })

  if (expired.length === 0 && ownerExpired.length === 0 && blendsOver.length === 0) {
    return { archived: 0, released: 0, hasMore: false }
  }

  const ids = [...expired, ...ownerExpired, ...blendsOver].map((group) => group.id)

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

  // Only another kind's: an archived event room stays readable to its members, as before.
  for (const { id } of [...ownerExpired, ...blendsOver]) closeRoomSockets(id)

  return {
    // What changed, not what was selected.
    archived: archived.count,
    released: released.count,
    hasMore: expired.length === SWEEP_BATCH || ownerExpired.length === SWEEP_BATCH || blendsOver.length === SWEEP_BATCH,
  }
}

/* -------------------------------------------------------------------------- */

let sweepTimer: ReturnType<typeof setTimeout> | null = null

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
 * Start the sweeper. Runs once immediately, then schedules itself.
 *
 * The immediate pass matters more than the interval: deploys restart this
 * process regularly, so boot is when the backlog from any downtime gets
 * cleared. Mirrors how `SponsoredMessageScheduler` rehydrates on start.
 *
 * ## Self-scheduling, like the other three
 *
 * This was the last `setInterval` with an async body in the codebase. The ops
 * broadcast was converted for the reason its comment gives — a pass slower than
 * the interval starts the next one on top of itself — and the two other
 * sweepers have always self-scheduled and say why.
 *
 * It is less likely to overlap here than there: the pass is bounded by
 * `SWEEP_BATCH` and the interval is minutes, not five seconds. It is not
 * impossible, and production has now shown these queries failing with
 * *"Server has closed the connection"* — a dropped Postgres connection, which
 * is exactly the kind of stall that makes a pass outlast its interval.
 *
 * The `finally` is what makes this safe: `runSweep` swallows its own errors, so
 * the only way the loop could stop is if it threw before returning, and
 * rescheduling from `finally` covers that too.
 */
export function startChatLifecycleSweeper(): void {
  if (sweepTimer) return

  const loop = async () => {
    try {
      await runSweep()
    } finally {
      sweepTimer = setTimeout(() => void loop(), SWEEP_INTERVAL_MS)
      // Do not hold the event loop open on its own account — a process with
      // nothing else to do should still be able to exit, which also keeps jest
      // from hanging if this is ever started in a test.
      sweepTimer.unref?.()
    }
  }

  void loop()
}

export function stopChatLifecycleSweeper(): void {
  if (sweepTimer) {
    clearTimeout(sweepTimer)
    sweepTimer = null
  }
}
