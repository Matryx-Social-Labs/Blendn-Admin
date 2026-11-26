/**
 * The shutdown's drains, in the order that loses nothing (SCRUM-1228, SCRUM-1404).
 *
 * The pool closes only after the product-events flush and the reminder pass in
 * flight have settled: the reminder sweeper claims before it sends, so closing
 * the pool under it left claimed rows with no push. Socket.io closes alongside
 * (its `close()` also closes the HTTP server). The process exits when all of it
 * has settled, and at `FORCED_EXIT_MS` with 1 whatever is still hanging; Railway
 * drains for 15 s (`.railway/railway.ts`), so the forced exit is ours, not a kill.
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

const capped = (work: Promise<unknown>, ms: number) => {
  let timer: NodeJS.Timeout | undefined
  const cap = new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))
  return Promise.race([work, cap]).finally(() => clearTimeout(timer))
}

// A step that throws synchronously is a rejected step, not a shutdown that never exits.
const attempt = (step: () => Promise<unknown>) => Promise.resolve().then(step)

export async function drainAndExit(steps: ShutdownSteps): Promise<void> {
  const forced = setTimeout(() => {
    console.error(`[${new Date().toISOString()}] > Forced shutdown after timeout`)
    steps.exit(1)
  }, FORCED_EXIT_MS)

  const db = Promise.allSettled([attempt(steps.flush), capped(attempt(steps.inFlight), IN_FLIGHT_CAP_MS)]).then(() =>
    attempt(steps.closeDb)
  )
  await Promise.allSettled([db, attempt(steps.closeIo)])

  clearTimeout(forced)
  steps.exit(0)
}
