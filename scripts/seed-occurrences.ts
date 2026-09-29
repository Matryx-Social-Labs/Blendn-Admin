import type { PrismaClient } from "@prisma/client"

type Db = Pick<PrismaClient, "event_occurrences">

/**
 * Hold every day of a seeded event's span at the spec's capacity, around `sync`
 * (the event's `syncOccurrences` call, left in the seed so the
 * events-have-occurrences guard still sees it).
 *
 * The seed re-times its events on every run, so the cancellations from the last
 * run are cleared first and the sync has the last word. The other way round
 * (SCRUM-471) undid the sync: `syncOccurrences` cancels a day that fell out of
 * the span but has attendance, and clearing `cancelled_at` across the event
 * afterwards brought that day back as a live session the event no longer has.
 */
export async function holdSeedOccurrences(
  db: Db,
  eventId: string,
  capacity: number | null,
  sync: () => Promise<void>
): Promise<void> {
  await db.event_occurrences.updateMany({ where: { event_id: eventId }, data: { cancelled_at: null } })
  await sync()
  await db.event_occurrences.updateMany({ where: { event_id: eventId }, data: { capacity } })
}
