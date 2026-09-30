import type { Prisma, PrismaClient } from "@prisma/client"

type Db = Pick<PrismaClient, "event_occurrences">
type RefreshDb = Pick<PrismaClient, "events" | "chat_groups" | "chat_group_members">

export type Refreshed =
  | { status: "missing" }
  | { status: "deleted" }
  | { status: "moved"; eventId: string; reopened: boolean }

/**
 * `--refresh-times` for one seeded event: its times, its days (`sync`), and a
 * room the archive sweep closed. Nothing a tester owns (SCRUM-482).
 *
 * A soft-deleted row is left alone. `seed-blr-scenarios --apply` retires every
 * other Bengaluru event, seed-qa's included, and the refresh went on moving
 * those rows, writing them occurrences and printing them as live: for three
 * days TEST-PLAN §4 handed every session a live event nobody could see.
 *
 * The sweep moved active and muted members alike to `left`, so a reopened room
 * has them all active again; bans are never touched.
 */
export async function refreshSeededEvent(
  db: RefreshDb,
  slug: string,
  when: { start: Date; end: Date; data?: Prisma.eventsUpdateInput },
  sync: (event: { id: string; timezone: string }) => Promise<void>
): Promise<Refreshed> {
  const event = await db.events.findUnique({
    where: { slug },
    select: { id: true, timezone: true, deleted_at: true },
  })
  if (!event) return { status: "missing" }
  if (event.deleted_at) return { status: "deleted" }

  await db.events.update({
    where: { id: event.id },
    data: { ...when.data, start_time: when.start, end_time: when.end },
  })
  await sync({ id: event.id, timezone: event.timezone })

  const archived = when.end > new Date()
    ? await db.chat_groups.findMany({ where: { event_id: event.id, status: "archived" }, select: { id: true } })
    : []
  if (archived.length) {
    const ids = archived.map((g) => g.id)
    await db.chat_groups.updateMany({ where: { id: { in: ids } }, data: { status: "active" } })
    await db.chat_group_members.updateMany({
      where: { chat_group_id: { in: ids }, status: "left" },
      data: { status: "active" },
    })
  }
  return { status: "moved", eventId: event.id, reopened: archived.length > 0 }
}

/** One line per event, and the line that says whether anything is live now. */
export function describeRefresh(slug: string, result: Refreshed, start: Date): string {
  if (result.status === "missing") return `  !  ${slug} is not seeded yet — run --apply once`
  if (result.status === "deleted") return `  !  ${slug} is soft-deleted — skipped`
  return `  ${slug.padEnd(34)} ${start.toISOString()}${result.reopened ? "  (room reopened)" : ""}`
}

export function describeLive(live: string[]): string {
  return live.length
    ? `\nlive now: ${live.join(", ")}`
    : "\n!! nothing this seed owns is live now — `npm run -s qa world` lists what is"
}

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
