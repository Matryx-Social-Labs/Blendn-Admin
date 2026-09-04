// Relative, not "@/lib/…", and this file only just started needing to be.
//
// It is now reachable from `server.ts` via lib/background.ts →
// lib/reminder-sweeper.ts, and `build:server` compiles with plain tsc, which
// emits the `@/` alias verbatim into the require() — MODULE_NOT_FOUND at boot,
// in production only. `lib/checkout.ts`, `lib/occupancy.ts` and
// `lib/presence-sessions.ts` all carry the same note for the same reason.
//
// Caught by the import-graph guard rather than by a deploy, which is the whole
// point of that test.
import { logger } from "../logger"
import { db } from "../db"
import { notifyEventUpdate } from "../push-notifications"
import type { rsvp_status } from "@prisma/client"

/**
 * Who hears about a change to an event.
 *
 * ```
 *   event_rsvps  going | maybe | waitlisted ─┐
 *                                            ├─> dedupe ─> push
 *   event_favorites  (saved it)             ─┘
 * ```
 *
 * Favourites alone was the wrong audience and it was the audience all three of
 * these functions used. A favourite is one tap on a card; an RSVP is a stated
 * intention to be somewhere, and `waitlisted` is someone actively waiting for a
 * seat — the person most affected when the event moves or dies. Someone can also
 * RSVP without ever favouriting, and that person was previously told nothing.
 *
 * Union rather than either alone, deduped, because the two tables answer
 * different questions and a person in both should not get two pushes.
 */
const COMMITTED: rsvp_status[] = ["going", "maybe", "waitlisted"]

async function interestedUserIds(eventId: string): Promise<string[]> {
  const [rsvps, favourites] = await Promise.all([
    db.event_rsvps.findMany({
      where: { event_id: eventId, status: { in: COMMITTED } },
      select: { user_id: true },
    }),
    db.event_favorites.findMany({
      where: { event_id: eventId },
      select: { user_id: true },
    }),
  ])

  return [...new Set([...rsvps, ...favourites].map((r) => r.user_id))]
}

/**
 * Send notifications to everyone who signalled intent when event details change.
 *
 * Deliberately not called for every edit — see `materialEventChanges`. A push
 * for a typo fix in the description is how people turn notifications off.
 */
export async function notifyEventDetailsChanged(
  eventId: string,
  eventTitle: string,
  changes: string[]
): Promise<void> {
  try {
    if (changes.length === 0) return

    const userIds = await interestedUserIds(eventId)
    if (userIds.length === 0) return

    const changeText = changes.join(", ")
    const message = `Event updated: ${changeText}`

    await notifyEventUpdate(userIds, eventTitle, message, eventId)
    logger.info("Event update notification sent", { eventId, recipientCount: userIds.length })
  } catch (error) {
    logger.error("Failed to send event update notification", { eventId, error: String(error) })
  }
}

/**
 * The changes worth waking somebody's phone for.
 *
 * Time and place are the two facts a person acts on — they leave the house for
 * them. A retitled event or an edited description changes nothing they have to
 * do, and pushing for it spends the one budget that cannot be topped up.
 *
 * Returns human-readable labels, because they are rendered directly in the push
 * body: "Event updated: start time, venue".
 */
export function materialEventChanges(
  before: {
    start_time: Date
    end_time: Date
    venue_name: string | null
    address: string | null
  },
  after: {
    start_time: Date
    end_time: Date
    venue_name: string | null
    address: string | null
  }
): string[] {
  const changes: string[] = []
  if (before.start_time.getTime() !== after.start_time.getTime()) changes.push("start time")
  if (before.end_time.getTime() !== after.end_time.getTime()) changes.push("end time")
  if ((before.venue_name ?? "") !== (after.venue_name ?? "")) changes.push("venue")
  if ((before.address ?? "") !== (after.address ?? "")) changes.push("address")
  return changes
}

/**
 * Send reminder notifications for events starting soon.
 * Call this from a cron job (e.g., every 15 minutes).
 */
export async function sendEventReminders(minutesBefore: number = 60): Promise<number> {
  const now = new Date()
  const reminderWindow = new Date(now.getTime() + minutesBefore * 60 * 1000)
  const windowEnd = new Date(reminderWindow.getTime() + 15 * 60 * 1000) // 15-min buffer

  try {
    // Find events starting within the reminder window
    const events = await db.events.findMany({
      where: {
        status: "published",
        deleted_at: null,
        start_time: {
          gte: reminderWindow,
          lt: windowEnd,
        },
        // Only ones nobody has reminded. Matches the partial index.
        reminded_at: null,
      },
      select: {
        id: true,
        title: true,
        start_time: true,
        venue_name: true,
      },
    })

    let totalNotified = 0

    for (const event of events) {
      /*
       * Claim the event before sending, not after.
       *
       * The window is fifteen minutes wide, so any scheduler running more
       * often than that re-selected the same event on every pass — three
       * pushes for a five-minute cron, saying the same thing. A conditional
       * update on `reminded_at` is an atomic compare-and-set: exactly one
       * caller sees `count === 1`, including across replicas, with no lock and
       * no queue.
       *
       * Claimed before the push rather than after, deliberately. The two ways
       * to be wrong are not symmetric: a claim that succeeds and a push that
       * fails costs one person one missed reminder, while a push that succeeds
       * and a claim that fails sends the whole room a second one.
       */
      const { count: claimed } = await db.events.updateMany({
        where: { id: event.id, reminded_at: null },
        data: { reminded_at: now },
      })
      if (claimed === 0) continue

      const userIds = await interestedUserIds(event.id)
      if (userIds.length === 0) continue

      const venuePart = event.venue_name ? ` at ${event.venue_name}` : ""
      const message = `Starting in ~${minutesBefore} minutes${venuePart}`

      await notifyEventUpdate(userIds, event.title, message, event.id)
      totalNotified += userIds.length
    }

    logger.info("Event reminders sent", { eventsCount: events.length, totalNotified })
    return totalNotified
  } catch (error) {
    logger.error("Failed to send event reminders", { error: String(error) })
    return 0
  }
}

/**
 * Notify everyone who signalled intent when an event is cancelled.
 *
 * Never throws. A cancellation must not fail because a push failed — the event
 * is cancelled either way, and the caller has already committed that write.
 */
export async function notifyEventCancelled(
  eventId: string,
  eventTitle: string
): Promise<void> {
  try {
    const userIds = await interestedUserIds(eventId)
    if (userIds.length === 0) return

    await notifyEventUpdate(
      userIds,
      eventTitle,
      "This event has been cancelled",
      eventId
    )
    logger.info("Event cancellation notification sent", { eventId, recipientCount: userIds.length })
  } catch (error) {
    logger.error("Failed to send cancellation notification", { eventId, error: String(error) })
  }
}
