// Relative imports: reached from lib/background.ts, which server.ts requires, and `build:server`
// compiles with plain tsc, which emits the @/ alias verbatim into the require().
import { ticketingOn } from "./env"
import { logger } from "./logger"
import { releaseExpiredHolds } from "./ticket-holds"

/**
 * Gives back ticket holds nobody paid for (SCRUM-1010), once a minute, while
 * `TICKETING` is on. A reserve already reclaims its own event's lapsed holds
 * inline; this is what returns them for an event nobody is buying at, so the
 * counts a dashboard reads are right too.
 *
 * Off means no timer at all. The flag is read once, at boot, as every env flag
 * is: turning it on is a deploy, and the first pass runs then.
 */
export const TICKET_HOLD_SWEEP_MS = 60_000
/** Batches per pass while they come back full: a burst clears in one pass without starving the loop. */
const MAX_BATCHES_PER_PASS = 10

let timer: ReturnType<typeof setTimeout> | null = null
let stopped = false

export async function sweepTicketHolds(): Promise<number> {
  let released = 0
  for (let batch = 0; batch < MAX_BATCHES_PER_PASS; batch++) {
    const pass = await releaseExpiredHolds()
    released += pass.released
    if (pass.released === 0) break
  }
  return released
}

async function run(): Promise<void> {
  try {
    const released = await sweepTicketHolds()
    if (released > 0) logger.info("Ticket holds released", { released })
  } catch (error) {
    logger.error("Ticket hold sweep failed", { error: error instanceof Error ? error.message : String(error) })
  }
}

/** Self-scheduling, like the other sweepers: a slow pass must not overlap the next. */
export function startTicketHoldSweeper(): void {
  if (timer || !ticketingOn()) return
  stopped = false
  const schedule = () => {
    if (stopped) return
    timer = setTimeout(() => void run().finally(schedule), TICKET_HOLD_SWEEP_MS)
    timer.unref?.()
  }
  void run().finally(schedule)
}

export function stopTicketHoldSweeper(): void {
  stopped = true
  if (timer) clearTimeout(timer)
  timer = null
}
