// Relative imports only: the re-check sweeper reaches this from `server.ts`,
// and `build:server` (plain tsc) would emit an `@/` alias verbatim.

/**
 * A circuit breaker for the OpenAI text check (moderation-degraded policy).
 *
 * While the vendor is down every send paid the full 1 s wait and its retry up
 * to the 8 s deadline. After `BREAKER_FAILURES_TO_OPEN` consecutive real
 * failures (an error or a timeout; a missing key is configuration and never
 * counts) the check answers "did not look" at once for `BREAKER_OPEN_MS`; the
 * next call after that is the probe. A success closes it, a failure reopens it.
 *
 * The state lives on `globalThis`: Next bundles its own copy of every module
 * the routes import, so a module-local variable would be one breaker for the
 * routes and another for the sweeper in `server.ts`.
 *
 * ponytail: per process, so each replica learns separately, which is fine. No
 * single-probe gate: calls that arrive together once the window ends all go
 * through as probes; add one if the vendor ever dislikes that.
 */
export const BREAKER_FAILURES_TO_OPEN = 5
export const BREAKER_OPEN_MS = 30_000

interface BreakerState {
  failures: number
  openUntil: number
}

const KEY = Symbol.for("blendn.moderation.textBreaker")

function state(): BreakerState {
  const holder = globalThis as unknown as { [KEY]?: BreakerState }
  return (holder[KEY] ??= { failures: 0, openUntil: 0 })
}

export function breakerIsOpen(): boolean {
  return Date.now() < state().openUntil
}

/** Closes the breaker; tests use it as the reset. */
export function recordTextSuccess(): void {
  const s = state()
  s.failures = 0
  s.openUntil = 0
}

export function recordTextFailure(): void {
  const s = state()
  s.failures += 1
  // Past the threshold every failure, a failed probe included, restarts the window.
  if (s.failures >= BREAKER_FAILURES_TO_OPEN) s.openUntil = Date.now() + BREAKER_OPEN_MS
}
