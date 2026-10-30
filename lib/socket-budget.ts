/**
 * A per-socket event budget (SCRUM-940).
 *
 * Typing and read receipts each run several queries and a room-wide emit, and
 * nothing bounded how often a socket could send them. A fixed window is enough:
 * a person using the app sends a handful of events a second at most, and a
 * reconnect re-joins its rooms in one burst well under the cap.
 *
 * ponytail: fixed window, so a burst straddling two windows can reach twice the
 * cap. Fine for load shedding; use a token bucket if it ever has to be exact.
 */
export function createEventBudget(max: number, windowMs: number, now: () => number = Date.now): () => boolean {
  let windowStart = now()
  let used = 0
  return () => {
    const t = now()
    if (t - windowStart >= windowMs) {
      windowStart = t
      used = 0
    }
    used += 1
    return used <= max
  }
}
