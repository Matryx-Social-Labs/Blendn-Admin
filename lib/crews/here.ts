// Relative imports: the Live tab's "Meeting tonight" (lib/live-social.ts) counts crews here from server.ts.
import { db } from "../db"
import { inRoomWhere } from "../event-kind"
import { notHostBannedFrom } from "../room-kind"

/*
 * Crew presence, the query (plan v2 §6; the why is in ./presence.ts): kept
 * apart from the crew cards so the custom server can count crews here without
 * loading room delivery and push.
 */

/** Checked in at this occurrence now. Spread into an `event_check_ins` filter. */
export function hereNowAt(occurrenceId: string, now: Date = new Date()) {
  return { occurrence_id: occurrenceId, kind: "attendee" as const, status: "checked_in" as const, check_out_time: null, ...inRoomWhere(undefined, now) }
}

/**
 * The members of each crew who are checked in at this occurrence now, by crew.
 * A crew a moderator hid (`hidden_at`) is here for nobody: its own members
 * still have their crew, but no card, like or Blend comes of it (C12).
 */
export async function presentMembersAt(occurrenceId: string, crewIds?: readonly string[]): Promise<Map<string, string[]>> {
  const rows = await db.crew_members.findMany({
    where: {
      ...(crewIds && { crew_id: { in: [...crewIds] } }),
      crew: { dissolved_at: null, hidden_at: null },
      user: {
        suspended_at: null,
        deletedAt: null,
        event_check_ins: { some: hereNowAt(occurrenceId) },
        // A member a host banned from this room is no crew member here (review H2).
        // any-kind: the room is this occurrence's, an event's or a venue day's alike — a crew can be here at either (§6).
        ...notHostBannedFrom({ event: { occurrences: { some: { id: occurrenceId } } } }),
      },
    },
    select: { crew_id: true, user_id: true },
  })
  const byCrew = new Map<string, string[]>()
  for (const r of rows) byCrew.set(r.crew_id, [...(byCrew.get(r.crew_id) ?? []), r.user_id])
  return byCrew
}

