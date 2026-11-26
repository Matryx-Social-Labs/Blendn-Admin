// Relative import: reached from server.ts, which `build:server` compiles with plain tsc.
import { logger } from "./logger"

/**
 * Which background loops are still running (SCRUM-1228).
 *
 * A loop that stops while the process stays up used to be found by users: the
 * presence sweeper stopping renders as occupancy climbing for ever. Each loop
 * calls `beat` when it starts and at the end of a pass that worked; a loop whose
 * last beat is older than `STALE_AFTER_INTERVALS` of its own interval is stale.
 * A loop that never started (the ticket loops while `TICKETING` is off) never
 * registers, so it is never stale.
 *
 * On `globalThis`: the loops run in `server.ts`'s copy of this module and
 * `/api/health` reads Next's copy (memory note socket-emits-need-globalthis).
 */
const STALE_AFTER_INTERVALS = 3

declare global {
  var __blendnHeartbeats:
    | { loops: Map<string, { at: number; intervalMs: number }>; reported: Map<string, number> }
    | undefined
}

function state() {
  globalThis.__blendnHeartbeats ??= { loops: new Map(), reported: new Map() }
  return globalThis.__blendnHeartbeats
}

export function beat(loop: string, intervalMs: number, now: number = Date.now()): void {
  state().loops.set(loop, { at: now, intervalMs })
}

export function staleLoops(now: number = Date.now()): string[] {
  return [...state().loops].filter(([, b]) => now - b.at > STALE_AFTER_INTERVALS * b.intervalMs).map(([loop]) => loop)
}

/**
 * The watchdog's pass: one error per stall (Sentry groups it by message, ops/07's
 * new-issue rule mails the team), one info line when the loop beats again. Never
 * throws: it runs on a timer in the process that serves every request.
 */
export function checkLoops(now: number = Date.now()): void {
  try {
    const { loops, reported } = state()
    const stale = new Set(staleLoops(now))
    for (const [loop, lastBeat] of reported) {
      if (stale.has(loop)) continue
      reported.delete(loop)
      logger.info("Background loop recovered", { loop, stalledSince: new Date(lastBeat).toISOString() })
    }
    for (const loop of stale) {
      if (reported.has(loop)) continue
      const { at, intervalMs } = loops.get(loop)!
      reported.set(loop, at)
      logger.error("Background loop stalled", { loop, lastBeatAt: new Date(at).toISOString(), intervalMs })
    }
  } catch {
    // The logger failing is the only way here; the next pass tries again.
  }
}
