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
 *   ping outside, > grace, not asked ─────────────▶  prompt
 *   ping outside, > grace + timeout, asked ───────▶  auto_checkout
 *   no ping, never left  ─────────────────────────▶  stay   (silence is ambiguous)
 *   no ping, was outside ─────────────────────────▶  the departure clock keeps running
 *   occurrence ended     ─────────────────────────▶  auto_checkout
 *   staff                ─────────────────────────▶  stay   (never auto)
 */

/** How often the client is asked to report. Battery over precision. */
export const PING_INTERVAL_MINUTES = 5

/** A cigarette, a phone call, an ATM. Not a departure. */
export const DEPARTURE_GRACE_MINUTES = 10

/** After we ask "are you still here?", before we act on the silence. */
export const PROMPT_TIMEOUT_MINUTES = 10

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
  | "prompt"
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
    | "no_response"
    | "occurrence_ended"
    | "staff_exempt"
    | "no_signal"
  /** Metres beyond the allowance, when the ping put them outside. */
  shortfall?: number
}

export interface PresenceState {
  kind: "attendee" | "staff"
  leftAreaAt: Date | null
  departurePromptedAt: Date | null
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

  if (state.departurePromptedAt === null) {
    // Grace is up. Ask once — never repeatedly for the same departure, which
    // `departurePromptedAt` is what guards.
    return { action: "prompt", reason: "grace_expired", shortfall }
  }

  const sincePrompt = now.getTime() - state.departurePromptedAt.getTime()
  if (sincePrompt < minutes(PROMPT_TIMEOUT_MINUTES)) {
    return { action: "stay", reason: "grace_expired", shortfall }
  }

  return { action: "auto_checkout", reason: "no_response", shortfall }
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
