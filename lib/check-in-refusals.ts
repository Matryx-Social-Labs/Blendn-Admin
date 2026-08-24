import type { refusal_reason } from "@prisma/client"

import { db } from "@/lib/db"
import { logger } from "@/lib/logger"

/**
 * Record that somebody was turned away at the door.
 *
 * ## What this is for
 *
 * A refused check-in produced a 400 and no record, so a wrong pin was invisible
 * until somebody complained — and most people do not complain, they leave. That
 * is worst for curated events, where an admin placed the pin from a listing
 * page without standing there, but an organiser who drew their fence around the
 * wrong building is equally blind.
 *
 * Three questions from one small table: is a pin wrong, is a fence too tight,
 * and how many people tried to get in and could not. The third is a real
 * product signal and nothing else measures it.
 *
 * ## Never throws, never awaited on the hot path
 *
 * The caller is already returning a 400. Turning that into a 500 because a
 * diagnostic write failed would replace a useful refusal with a useless one.
 *
 * ## No coordinates
 *
 * `shortfallMetres` is how far outside they were. That is everything the
 * diagnosis needs and it cannot locate anybody. G11 found GPS surviving account
 * deletion on `event_check_ins`; adding a second table with the same problem in
 * order to fix the first would be absurd.
 */
export function recordRefusal(input: {
  eventId: string
  userId: string
  reason: refusal_reason
  occurrenceId?: string | null
  /** Metres beyond the fence, buffer and accuracy allowance. Distance only. */
  shortfallMetres?: number | null
  accuracyMetres?: number | null
}): void {
  db.check_in_refusals
    .create({
      data: {
        event_id: input.eventId,
        user_id: input.userId,
        reason: input.reason,
        occurrence_id: input.occurrenceId ?? null,
        // Rounded: a sub-metre shortfall is false precision on a GPS fix, and
        // the number is read by a human deciding whether to move a pin.
        shortfall_metres:
          input.shortfallMetres === null || input.shortfallMetres === undefined
            ? null
            : Math.round(input.shortfallMetres),
        accuracy_metres:
          input.accuracyMetres === null || input.accuracyMetres === undefined
            ? null
            : Math.round(input.accuracyMetres),
      },
    })
    .catch((error: unknown) =>
      logger.warn("Could not record check-in refusal", {
        eventId: input.eventId,
        reason: input.reason,
        error: error instanceof Error ? error.message : String(error),
      })
    )
}

/**
 * How badly an event is turning people away.
 *
 * ## The one number for curation health
 *
 * `distinctPeopleRefused` against `checkedIn`. A curated event that ended with
 * refusals and no check-ins is a wrong pin, and it is the only figure that
 * catches one — a wrong time or a dead listing produce the same silence and are
 * distinguishable only by whether anybody tried.
 *
 * People, not rows, for the reason `lib/counting.ts` documents at length: one
 * person trying four times from the pavement is one person with a problem, and
 * counting attempts would make them look like a crowd.
 *
 * `medianShortfall` is the diagnostic. Everybody twenty metres out is a pin on
 * the wrong side of the street; a wide spread is a fence that is simply too
 * tight for the venue.
 */
export interface RefusalSummary {
  distinctPeopleRefused: number
  attempts: number
  medianShortfallMetres: number | null
  /** Which reason dominates. A wrong pin and a wrong time look identical without it. */
  topReason: refusal_reason | null
}

export async function refusalSummary(eventId: string): Promise<RefusalSummary> {
  const rows = await db.check_in_refusals.findMany({
    where: { event_id: eventId },
    select: { user_id: true, reason: true, shortfall_metres: true },
    // Bounded. A pathological event does not get to pull its whole history into
    // a dashboard render, and a thousand refusals says the same as ten thousand.
    take: 1_000,
    orderBy: { created_at: "desc" },
  })

  if (rows.length === 0) {
    return { distinctPeopleRefused: 0, attempts: 0, medianShortfallMetres: null, topReason: null }
  }

  const shortfalls = rows
    .map((r) => r.shortfall_metres)
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b)

  const byReason = new Map<refusal_reason, number>()
  for (const r of rows) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1)

  return {
    distinctPeopleRefused: new Set(rows.map((r) => r.user_id)).size,
    attempts: rows.length,
    medianShortfallMetres:
      shortfalls.length === 0
        ? null
        : shortfalls[Math.floor((shortfalls.length - 1) / 2)],
    topReason: [...byReason.entries()].sort((a, b) => b[1] - a[1])[0][0],
  }
}
