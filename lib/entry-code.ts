import type { event_kind, event_status } from "@prisma/client"

import { DOORS_LEAD_MINUTES } from "@/lib/chat-window"
import { pickOccurrence, type OccurrenceSlot } from "@/lib/occurrences"
import { normaliseCode, rotatingCode } from "@/lib/rotating-code"

/**
 * The event's door code (gate 13, SCRUM-1316; design/02a SPEC §1): the host's
 * screen shows it, a guest whose GPS cannot place them types it in the app.
 *
 * Named "entry code" in code so a search never meets the ticket's door code
 * (`lib/tickets.ts`, parked). Stored values keep the spec's names:
 * `check_in_method` `door_code`, the `door_code_*` refusal reasons,
 * `events.door_code_paused_at`.
 *
 * One per occurrence, under its own HKDF label: never the offer pass's key.
 * Only the dashboard reads it (`canOperate`); the mobile API never returns it.
 */

const entry = rotatingCode("blendn door-code v1")
const subject = (eventId: string, occurrenceId: string) => `${eventId}:${occurrenceId}`

/** Steps accepted besides the current one: 60-90 s from reading to submitting, for screen-reader and switch users (WCAG 2.2.1). */
const GRACE_STEPS = 2
/** How far short of the fence (after the accuracy allowance) a guest with the code may stand: across the road is fine, home is not. */
export const ENTRY_CODE_NEAR_M = 1_000
/** How long a pause holds before it lifts itself. */
export const ENTRY_PAUSE_MS = 10 * 60_000

export const entryCode = (eventId: string, occurrenceId: string, step: number): string => entry.code(subject(eventId, occurrenceId), step)

export const currentEntryCode = (eventId: string, occurrenceId: string, now: Date): { code: string; rotatesAt: string } =>
  entry.current(subject(eventId, occurrenceId), now)

/** A misread across a doorway still matches: 8 is B, 5 is S, 2 is Z, both sides. */
export const foldConfusables = (code: string): string => code.replace(/8/g, "B").replace(/5/g, "S").replace(/2/g, "Z")

export type EntryCodeMatch = "match" | "changed" | "wrong"

/** The current step or the two before it match; the one before those "just changed" and is not a guess. */
export function matchEntryCode(eventId: string, occurrenceId: string, typed: string, now: Date): EntryCodeMatch {
  const code = normaliseCode(typed)
  if (!code) return "wrong"
  const back = entry.stepsBack(subject(eventId, occurrenceId), code, now, GRACE_STEPS + 1, foldConfusables)
  if (back === null) return "wrong"
  return back <= GRACE_STEPS ? "match" : "changed"
}

/**
 * Whether a pause holds now: set at or after this occurrence's doors (last
 * Friday's pause never carries into this Friday) and less than ten minutes ago.
 */
export function entryPauseInForce(pausedAt: Date | null, occurrence: { startTime: Date }, now: Date): boolean {
  if (!pausedAt) return false
  const doors = occurrence.startTime.getTime() - DOORS_LEAD_MINUTES * 60_000
  return pausedAt.getTime() >= doors && now.getTime() - pausedAt.getTime() <= ENTRY_PAUSE_MS
}

/** The event-wide trip: enough wrong codes, and more wrong than right, so a busy honest door full of typos never trips it. */
export const tripsEntryPause = (wrong: number, correct: number): boolean => wrong >= 30 && wrong > correct

export interface EntryCodeEvent {
  status: event_status
  kind: event_kind
  door_code_paused_at: Date | null
}

/** The occurrence whose door code is live now, or null: published, not a venue day, doors to end, not cancelled, not paused. */
export function entryCodeOpen(event: EntryCodeEvent, slots: readonly OccurrenceSlot[], now: Date): OccurrenceSlot | null {
  if (event.status !== "published" || event.kind === "venue_day") return null
  const verdict = pickOccurrence(slots, now)
  if (!verdict.ok || entryPauseInForce(event.door_code_paused_at, verdict.occurrence, now)) return null
  return verdict.occurrence
}

/** `doorCode.available` on the event payload: the code is live and not paused. Never the code. */
export function entryCodeAvailable(
  event: EntryCodeEvent & { occurrences: ReadonlyArray<{ start_time: Date; end_time: Date; cancelled_at: Date | null }> },
  now: Date
): boolean {
  const slots = event.occurrences.map((o, i) => ({
    id: String(i),
    occursOn: o.start_time,
    startTime: o.start_time,
    endTime: o.end_time,
    capacity: null,
    cancelledAt: o.cancelled_at,
  }))
  return entryCodeOpen(event, slots, now) !== null
}

/** What the guest is told. The server owns the sentences (SPEC §4). */
export const ENTRY_CODE_SAYS = {
  wrong: "That code didn't match. Check the host's screen; it may have just changed.",
  changed: "That code just changed. Read the new one on the host's screen.",
  far: "You need to be at the venue to use the door code.",
  lockedUntil: (time: string) => `Too many tries. Try again at ${time}, or step outside and use GPS.`,
  lockedTonight: "Too many tries tonight. Step outside and use GPS.",
  paused: "The door code is paused. Ask the host.",
  unavailable: "The door code isn't available right now. Try GPS.",
} as const
