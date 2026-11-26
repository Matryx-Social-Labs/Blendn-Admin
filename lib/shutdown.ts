// Relative import: reached from server.ts, which `build:server` compiles with plain tsc.
import { logger } from "./logger"

/**
 * The shutdown's drains, in the order that loses nothing (SCRUM-1228, SCRUM-1404).
 *
 * The pool closes only after the product-events flush, the reminder pass in
 * flight and Socket.io have settled: the reminder sweeper claims before it sends,
 * so closing the pool under it left claimed rows with no push, and `io.close()`
 * also closes the HTTP server, which waits for the requests still running. The
 * process exits once the pool is closed, and at `FORCED_EXIT_MS` with 1 whatever
 * is still hanging; Railway drains for 15 s (`.railway/railway.ts`), so the
 * forced exit is ours, not a kill. A step that failed, and a reminder pass cut
 * off at its cap, are logged: claimed reminders may be unsent.
 */
export const FORCED_EXIT_MS = 10_000
/** How long the reminder pass gets to finish its sends; inside the forced exit, with room for closing the pool. */
export const IN_FLIGHT_CAP_MS = 8_000

export interface ShutdownSteps {
  flush: () => Promise<unknown>
  inFlight: () => Promise<unknown>
  closeDb: () => Promise<unknown>
  closeIo: () => Promise<unknown>
  exit: (code: number) => void
}

const CUT_OFF = Symbol("cut off")

const capped = (work: Promise<unknown>, ms: number) => {
  let timer: NodeJS.Timeout | undefined
  const cap = new Promise<typeof CUT_OFF>((resolve) => (timer = setTimeout(() => resolve(CUT_OFF), ms)))
  return Promise.race([work, cap]).finally(() => clearTimeout(timer))
}

const failed = (step: string) => (error: unknown) => {
  logger.error("Shutdown step failed", { step, error: error instanceof Error ? error.message : String(error) })
}

export async function drainAndExit(steps: ShutdownSteps): Promise<void> {
  const forced = setTimeout(() => {
    logger.error("Forced shutdown after timeout", { afterMs: FORCED_EXIT_MS })
    steps.exit(1)
  }, FORCED_EXIT_MS)

  await Promise.all([
    steps.flush().catch(failed("flush")),
    capped(steps.inFlight(), IN_FLIGHT_CAP_MS).then((r) => {
      if (r === CUT_OFF) logger.error("Shutdown stopped waiting for the reminder pass", { afterMs: IN_FLIGHT_CAP_MS })
    }, failed("reminder pass")),
    steps.closeIo().catch(failed("io")),
  ])
  await steps.closeDb().catch(failed("closeDb"))

  clearTimeout(forced)
  steps.exit(0)
}
