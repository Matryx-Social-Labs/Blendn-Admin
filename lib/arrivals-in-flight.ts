/**
 * Arrivals still being announced, so a departure is never told first.
 *
 * The check-in answers before the room hears of the arrival (`seatAtTheDoor`
 * → `announceArrival`, not awaited). Arrive and check out fast enough and the
 * checkout's `event:checkout` could reach the room before the arrival's
 * `event:room:checkin`, leaving a ghost on the live roster. `performCheckout`
 * waits here for the person's arrival broadcast before sending its own.
 *
 * On globalThis, not in module scope: Next bundles its own copy of a module
 * per layer (memory: socket emits need globalThis), and the sweeper runs from
 * server.ts. Relative imports only — reachable from server.ts.
 */
const shared = globalThis as typeof globalThis & { __blendnArrivalsInFlight?: Map<string, Promise<void>> }
const inFlight = (shared.__blendnArrivalsInFlight ??= new Map())

/** How long a departure waits for an arrival before going out anyway: a stuck read must not hold a checkout. */
export const ARRIVAL_WAIT_MS = 2_000

const keyOf = (eventId: string, userId: string) => `${eventId}:${userId}`

/** Track this arrival's broadcast until it settles. `announce` must not reject. */
export function trackArrival(eventId: string, userId: string, announce: Promise<void>): Promise<void> {
  const key = keyOf(eventId, userId)
  const tracked = announce.finally(() => {
    if (inFlight.get(key) === tracked) inFlight.delete(key)
  })
  inFlight.set(key, tracked)
  return tracked
}

/** Settles once this person's arrival here has been announced (or at once, or after ARRIVAL_WAIT_MS). */
export async function arrivalAnnounced(eventId: string, userId: string): Promise<void> {
  const pending = inFlight.get(keyOf(eventId, userId))
  if (!pending) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([pending, new Promise<void>((resolve) => (timer = setTimeout(resolve, ARRIVAL_WAIT_MS)))])
  clearTimeout(timer)
}
