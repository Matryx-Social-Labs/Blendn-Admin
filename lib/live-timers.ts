// Relative imports: reached from the routes and, through the sweeper, from
// server.ts — `build:server` emits an @/ alias verbatim into the require().
import { performCheckout } from "./checkout"
import { db } from "./db"
import { logger } from "./logger"

/**
 * A Go Live ends at its second, not at the next sweep (step 4 review).
 *
 * The room's doors already compare the window with the clock
 * (`liveInVenueDay`), but a socket that joined while live stays in the room
 * until something takes it out — and the only thing that did was the checkout,
 * which waited for the five-minute sweeper. So each window schedules its own
 * end: at `expires_at` the check-in is checked out `expired`, which evicts the
 * person's sockets from the venue's rooms (`evictFromVenueDay`).
 *
 * Per process, in memory: a restart or a deploy loses the timers, and the
 * expiry sweep (every 30 s) is the backstop. With more than one replica the
 * eviction reaches sockets on the others only through the Redis adapter, so
 * `REDIS_URL` must be set wherever more than one replica runs. On the
 * globalThis so Next's bundled copy of this module and server.ts's share one
 * map, as the socket server does.
 */

const shared = globalThis as typeof globalThis & { __blendnLiveTimers?: Map<string, NodeJS.Timeout> }
const timers = (shared.__blendnLiveTimers ??= new Map<string, NodeJS.Timeout>())

/** Longer than any window can be (four hours of "stay"); anything past it is the sweeper's. */
const LONGEST_MS = 5 * 60 * 60_000

/** A little after the end, so the row reads ended when the timer looks. */
const SLACK_MS = 250

/** Schedule (or move) the end of one Go Live. */
export function scheduleLiveEnd(checkInId: string, expiresAt: Date): void {
  clearLiveEnd(checkInId)
  const delay = expiresAt.getTime() - Date.now()
  if (delay > LONGEST_MS) return
  const timer = setTimeout(() => {
    timers.delete(checkInId)
    void endIfExpired(checkInId)
  }, Math.max(0, delay) + SLACK_MS)
  timer.unref?.()
  timers.set(checkInId, timer)
}

export function clearLiveEnd(checkInId: string): void {
  const timer = timers.get(checkInId)
  if (timer) clearTimeout(timer)
  timers.delete(checkInId)
}

/** End the window if it is still open past its end; anything else already happened. */
export async function endIfExpired(checkInId: string, now: Date = new Date()): Promise<boolean> {
  try {
    const row = await db.event_check_ins.findUnique({
      where: { id: checkInId },
      select: { status: true, expires_at: true },
    })
    if (row?.status !== "checked_in" || !row.expires_at || row.expires_at > now) return false
    const done = await performCheckout(checkInId, "expired", row.expires_at)
    return done?.changed ?? false
  } catch (error) {
    // The sweeper will do it; a timer must never take the process down.
    logger.warn("Go Live end timer failed", { checkInId, error: error instanceof Error ? error.message : String(error) })
    return false
  }
}
