import { evaluateCheckIn, type Geofence, type LatLng } from "./geofence"

/**
 * Is this person still here?
 *
 * Check-in is a one-shot gate: it proves you were at the venue once and then
 * nothing revisits the claim. Someone who walks out without pressing "check
 * out" stays counted for ever, which is the single largest source of error in
 * the number the live screen exists to make trustworthy.
 *
 * This decides, from one location ping, what to do about it.
 *
 * **Pure on purpose.** Everything hard here is judgment about noisy sensor
 * data, and judgment belongs somewhere cheap to test. `lib/geofence.ts` is the
 * same shape and is the most-tested module in the repo with no production
 * defects; the alternative is discovering these rules against a real venue.
 *
 *
 *   ping inside          ─────────────────────────▶  stay
 *   ping inside, was out ─────────────────────────▶  clear_departure
 *   ping outside, first  ─────────────────────────▶  record_departure
 *   ping outside, > departure allowance ──────────▶  auto_checkout
 *   no ping, never left  ─────────────────────────▶  stay   (silence is ambiguous)
 *   no ping, was outside ─────────────────────────▶  the departure clock keeps running
 *   occurrence ended     ─────────────────────────▶  auto_checkout
 *   staff                ─────────────────────────▶  stay   (never auto)
 */

/** How often the client is asked to report. Battery over precision. */
export const PING_INTERVAL_MINUTES = 5

/** A cigarette, a phone call, an ATM. Not a departure. */
export const DEPARTURE_GRACE_MINUTES = 10

/**
 * How long somebody may be outside the fence before the room stops counting them.
 *
 * ## There used to be a prompt here, and it asked nobody anything
 *
 * The flow was: grace expires, emit a `prompt` action, wait
 * `PROMPT_TIMEOUT_MINUTES`, then auto-checkout with `reason: "no_response"`.
 * The `prompt` action's only effect was writing `departure_prompted_at` -- **no
 * push, no socket event, nothing reached the phone**. So the sweeper recorded
 * "no response" to a question it had never asked, and the ten minutes it waited
 * for that answer were ten minutes of a stale occupancy number.
 *
 * The prompt is gone rather than built. Delivering it would mean a notification
 * kind, a response endpoint and a screen, to ask a question whose answer is
 * already being measured -- if they are back inside, the next ping says so and
 * clears the departure by itself.
 *
 * **The total tolerance is unchanged at 20 minutes**, deliberately. Removing the
 * prompt and keeping only the grace would have halved how long somebody can be
 * out before being closed out, and the 2026-08-08 thesis names indoor GPS on
 * cheap Android in dense venues as an execution risk against the core mechanic.
 * Removing a fiction should not also tighten a threshold; that is a separate
 * decision with its own evidence.
 */
export const DEPARTURE_ALLOWANCE_MINUTES = 20

/**
 * How far past an occurrence's end someone can still be counted as inside.
 *
 * The room does not empty at the stroke of the end time, but nobody is still
 * there an hour later either.
 */
export const OCCURRENCE_GRACE_MINUTES = 60

export type PresenceAction =
  | "stay"
  | "record_departure"
  // `prompt` is gone. It wrote a timestamp and notified nobody; see
  // DEPARTURE_ALLOWANCE_MINUTES.
  | "auto_checkout"
  | "clear_departure"

export interface PresenceDecision {
  action: PresenceAction
  /** Why, in a form the caller can log and the client can render. */
  reason:
    | "inside"
    | "returned"
    | "left_area"
    | "grace_expired"
    | "occurrence_ended"
    | "staff_exempt"
    | "no_signal"
  /** Metres beyond the allowance, when the ping put them outside. */
  shortfall?: number
}

export interface PresenceState {
  kind: "attendee" | "staff"
  leftAreaAt: Date | null
  lastSeenAt: Date | null
}

export interface PresencePing {
  point: LatLng
  /** Metres, as the device reports it. Null when it will not say. */
  accuracy: number | null
}

const minutes = (n: number) => n * 60_000

export function evaluatePresence(
  state: PresenceState,
  ping: PresencePing | null,
  fence: Geofence,
  occurrenceEndsAt: Date,
  now: Date = new Date()
): PresenceDecision {
  /*
   * The day is over. Everyone still checked in is closed out, staff included —
   * this is the one automatic checkout staff are not exempt from, because the
   * alternative is their check-in staying open for ever and day two of a
   * conference counting them twice.
   */
  if (now.getTime() > occurrenceEndsAt.getTime() + minutes(OCCURRENCE_GRACE_MINUTES)) {
    return { action: "auto_checkout", reason: "occurrence_ended" }
  }

  /*
   * Staff move around: the back office, outside working the queue, into the
   * street to meet a supplier. Auto-ejecting the organiser from their own
   * event — and from the chatroom they are moderating — is worse than a
   * slightly stale staff count. They check out by hand.
   */
  if (state.kind === "staff") {
    return { action: "stay", reason: "staff_exempt" }
  }

  /*
   * Silence, with no evidence they ever left.
   *
   * No ping can mean: the app is backgrounded, iOS suspended it, the venue is a
   * basement with no signal, the battery died, the permission was revoked,
   * someone turned on airplane mode. None of those mean the person left, and a
   * venue whose signal dies must never read as an evacuation.
   *
   * So silence on its own never does anything. It is resolved by the
   * occurrence-ended branch above and nowhere else.
   *
   * Silence *after* a confirmed out-of-fence reading is a different thing, and
   * falls through to the departure clock below: there we have positive evidence
   * they stepped out, we asked them, and they did not answer. That is what the
   * prompt is for, and only the sweeper — which never carries a ping — can ever
   * observe the timeout expiring.
   */
  if (ping === null && state.leftAreaAt === null) {
    return { action: "stay", reason: "no_signal" }
  }

  /*
   * Judged with the same allowance as check-in itself.
   *
   * A 100m fix inside a 30m fence is evidence of being indoors, not of having
   * left. Reusing `evaluateCheckIn` means the two can never disagree — a
   * separate "are they outside" rule would drift from the one that let them in.
   */
  const verdict = ping ? evaluateCheckIn(ping.point, fence, ping.accuracy) : null

  if (verdict?.ok) {
    // Back inside. Whatever we thought was happening, it was not a departure.
    return state.leftAreaAt === null
      ? { action: "stay", reason: "inside" }
      : { action: "clear_departure", reason: "returned" }
  }

  const shortfall = verdict?.ok === false ? verdict.shortfall : undefined

  if (state.leftAreaAt === null) {
    // First reading outside. Start the clock; do not act on one sample.
    return { action: "record_departure", reason: "left_area", shortfall }
  }

  const outFor = now.getTime() - state.leftAreaAt.getTime()
  if (outFor < minutes(DEPARTURE_GRACE_MINUTES)) {
    return { action: "stay", reason: "left_area", shortfall }
  }

  if (outFor < minutes(DEPARTURE_ALLOWANCE_MINUTES)) {
    return { action: "stay", reason: "grace_expired", shortfall }
  }

  // `left_area`, not `no_response`: nobody was asked anything.
  return { action: "auto_checkout", reason: "left_area", shortfall }
}

/**
 * Should this ping be written at all?
 *
 * 500 attendees pinging every five minutes is 100 writes a minute if every one
 * is persisted, and close to zero if only the interesting ones are. A ping that
 * changes nothing and arrives sooner than the interval is noise.
 */
export function shouldPersistPing(
  decision: PresenceDecision,
  state: PresenceState,
  now: Date = new Date()
): boolean {
  if (decision.action !== "stay") return true
  if (state.lastSeenAt === null) return true
  return now.getTime() - state.lastSeenAt.getTime() >= minutes(PING_INTERVAL_MINUTES)
}
