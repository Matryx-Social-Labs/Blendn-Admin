import { errorResponse } from "@/lib/api-response"
import { auditLog } from "@/lib/audit-log"
import { recordRefusal } from "@/lib/check-in-refusals"
import { db } from "@/lib/db"
import { DOORS_LEAD_MINUTES } from "@/lib/chat-window"
import { ENTRY_CODE_NEAR_M, ENTRY_CODE_SAYS, ENTRY_PAUSE_MS, entryPauseInForce, matchEntryCode, tripsEntryPause } from "@/lib/entry-code"
import { evaluateCheckIn, type Geofence } from "@/lib/geofence"
import { logger } from "@/lib/logger"
import { mobileTime } from "@/lib/mobile-datetime"
import type { OccurrenceSlot } from "@/lib/occurrences"
import { forget, hit, peek, release, StoreUnavailable } from "@/lib/rate-limit-store"
import { normaliseCode } from "@/lib/rotating-code"

/**
 * The door code at the event door (gate 13; design/02a SPEC §2): what stands
 * in for the fence when a guest types the host's code. Paused, locked and far
 * all answer before the code is compared, so none of them says anything about
 * the code.
 *
 * Counters are Redis or nothing (`failClosed`): with Redis down the code path
 * refuses and GPS is untouched. Every key is per occurrence. Only a mismatch
 * counts; a code from just before the grace ("changed") counts nothing.
 */

/** A fix vaguer than this says nothing about where the person is. Replaces the 150 m ceiling on this path. */
const ACCURACY_CEILING_M = 1_000
const WINDOW_MS = 10 * 60_000
const PERSON_WRONG = 5
const PERSON_NIGHT_WRONG = 10
const CLOSED = { failClosed: true } as const

const personKey = (occurrenceId: string, userId: string) => `entry-fail:${occurrenceId}:${userId}`
const nightKey = (occurrenceId: string, userId: string) => `entry-night:${occurrenceId}:${userId}`
const wrongKey = (occurrenceId: string) => `entry-wrong:${occurrenceId}`
const rightKey = (occurrenceId: string) => `entry-right:${occurrenceId}`

export interface EntryCodeAttempt {
  event: { id: string; timezone: string; door_code_paused_at: Date | null }
  occurrence: OccurrenceSlot
  userId: string
  typed: string
  fence: Geofence | null
  point: { lat: number; lng: number }
  gpsAccuracy: number | undefined
  mocked: boolean
  now: Date
}

type Refusal = ReturnType<typeof errorResponse>

/** Null to seat the person with method `door_code`, else the refusal to send. */
export async function entryCodeGate(a: EntryCodeAttempt): Promise<Refusal | null> {
  const record = (reason: "door_code_wrong" | "door_code_far" | "door_code_locked" | "door_code_paused", extra: { shortfallMetres?: number } = {}) =>
    recordRefusal({ eventId: a.event.id, userId: a.userId, reason, occurrenceId: a.occurrence.id, accuracyMetres: a.gpsAccuracy, ...extra })

  if (entryPauseInForce(a.event.door_code_paused_at, a.occurrence, a.now)) {
    record("door_code_paused")
    return errorResponse(ENTRY_CODE_SAYS.paused, 400, "DOOR_CODE_PAUSED")
  }

  try {
    const { locked, giveBack } = await reserveAttempt(a)
    if (locked) {
      await giveBack()
      record("door_code_locked")
      return errorResponse(locked, 429, "DOOR_CODE_LOCKED")
    }

    const shortfall = shortfallOf(a)
    if (shortfall === null || shortfall > ENTRY_CODE_NEAR_M) {
      await giveBack()
      record("door_code_far", shortfall === null ? {} : { shortfallMetres: shortfall })
      return errorResponse(ENTRY_CODE_SAYS.far, 400, "DOOR_CODE_FAR")
    }

    const match = matchEntryCode(a.event.id, a.occurrence.id, a.typed, a.now)
    if (match === "match") {
      await Promise.all([giveBack(), hit(rightKey(a.occurrence.id), WINDOW_MS, CLOSED)])
      return null
    }
    if (match === "changed") {
      await giveBack()
      return errorResponse(ENTRY_CODE_SAYS.changed, 400, "DOOR_CODE_CHANGED")
    }

    if (normaliseCode(a.typed)) await countEventWrong(a)
    record("door_code_wrong")
    return errorResponse(ENTRY_CODE_SAYS.wrong, 400, "DOOR_CODE_WRONG")
  } catch (error) {
    if (!(error instanceof StoreUnavailable)) throw error
    logger.error("Door code counters unavailable: refusing the code path", { eventId: a.event.id })
    return errorResponse(ENTRY_CODE_SAYS.unavailable, 503, "DOOR_CODE_UNAVAILABLE")
  }
}

/**
 * Count this attempt against the person before anything is compared, so a
 * burst of parallel guesses cannot all read "under the limit" (reserve, then
 * check); `giveBack` returns it for anything that is not a wrong code. Locked:
 * removed from the room by the host (the answer to a shared code), over ten
 * wrong tonight, or over five in ten minutes, with the time it lifts.
 */
async function reserveAttempt(a: EntryCodeAttempt): Promise<{ locked: string | null; giveBack: () => Promise<void> }> {
  const keys = [personKey(a.occurrence.id, a.userId), nightKey(a.occurrence.id, a.userId)] as const
  const tonightMs = Math.max(a.occurrence.endTime.getTime() - a.now.getTime(), 0) + 60 * 60_000
  const [removed, recent, tonight] = await Promise.all([
    db.chat_group_members.findFirst({ where: { user_id: a.userId, status: "banned", chat_group: { event_id: a.event.id } }, select: { user_id: true } }),
    hit(keys[0], WINDOW_MS, CLOSED),
    hit(keys[1], tonightMs, CLOSED),
  ])
  const giveBack = async () => {
    await Promise.all(keys.map((k) => release(k)))
  }
  if (removed || tonight.count > PERSON_NIGHT_WRONG) return { locked: ENTRY_CODE_SAYS.lockedTonight, giveBack }
  if (recent.count > PERSON_WRONG) return { locked: ENTRY_CODE_SAYS.lockedUntil(mobileTime(new Date(recent.resetAt), a.event.timezone)), giveBack }
  return { locked: null, giveBack }
}

/** Metres short of the fence, or null when the fix cannot place the person at all (no accuracy, too vague, mocked, no fence). */
function shortfallOf(a: EntryCodeAttempt): number | null {
  if (a.mocked || a.gpsAccuracy === undefined || a.gpsAccuracy > ACCURACY_CEILING_M || !a.fence) return null
  const verdict = evaluateCheckIn(a.point, a.fence, a.gpsAccuracy)
  return verdict.ok ? 0 : verdict.shortfall
}

/**
 * A wrong code that could be one counts against the event too, and may pause it.
 * ponytail: the trip reads the counts after its own hit, so a burst can trip a few attempts late; the pause still lands.
 */
async function countEventWrong(a: EntryCodeAttempt): Promise<void> {
  const occurrenceId = a.occurrence.id
  const [wrong, right] = await Promise.all([hit(wrongKey(occurrenceId), WINDOW_MS, CLOSED), peek(rightKey(occurrenceId), CLOSED)])
  if (tripsEntryPause(wrong.count, right)) await setEntryPause(a.event.id, a.occurrence, null, a.now, { wrong: wrong.count, correct: right })
}

/**
 * Pause the code now: by a host (`by`), or by the system (`null`). A pause
 * already in force is left as it is and not audited again.
 */
export async function setEntryPause(
  eventId: string,
  occurrence: { id: string; startTime: Date },
  by: string | null,
  now: Date,
  details: Record<string, number> = {}
): Promise<void> {
  // Not in force: none, another night's (before these doors), or lifted (over ten minutes old). `entryPauseInForce`, as a filter.
  const stale = new Date(Math.max(now.getTime() - ENTRY_PAUSE_MS, occurrence.startTime.getTime() - DOORS_LEAD_MINUTES * 60_000))
  const changed = await db.events.updateMany({
    where: { id: eventId, OR: [{ door_code_paused_at: null }, { door_code_paused_at: { lt: stale } }] },
    data: { door_code_paused_at: now },
  })
  if (changed.count === 0) return
  auditLog({
    userId: by ?? undefined,
    action: "event.door_code_paused",
    resource: "event",
    resourceId: eventId,
    details: { eventId, occurrenceId: occurrence.id, by: by ? "host" : "system", ...details },
  })
}

/** Resume: the pause is lifted and the event's counters start again, so the next typo does not re-pause it. */
export async function clearEntryPause(eventId: string, occurrenceId: string, by: string): Promise<void> {
  await db.events.update({ where: { id: eventId }, data: { door_code_paused_at: null } })
  await Promise.all([forget(wrongKey(occurrenceId)), forget(rightKey(occurrenceId))])
  auditLog({ userId: by, action: "event.door_code_resumed", resource: "event", resourceId: eventId, details: { eventId, occurrenceId } })
}

/** Wrong codes in the event's window, for the paused sentence; null when the store cannot say. */
export async function recentWrongCodes(occurrenceId: string): Promise<number | null> {
  try {
    return await peek(wrongKey(occurrenceId), CLOSED)
  } catch (error) {
    if (error instanceof StoreUnavailable) return null
    throw error
  }
}
