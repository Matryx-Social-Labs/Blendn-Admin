import { db } from "@/lib/db"
import { notifyEventUpdate } from "@/lib/push-notifications"
import { logger } from "@/lib/logger"

/**
 * Send notifications to all interested users when event details change
 */
export async function notifyEventDetailsChanged(
  eventId: string,
  eventTitle: string,
  changes: string[]
): Promise<void> {
  try {
    const interested = await db.event_favorites.findMany({
      where: { event_id: eventId },
      select: { user_id: true },
    })

    if (interested.length === 0) return

    const userIds = interested.map((f) => f.user_id)
    const changeText = changes.join(", ")
    const message = `Event updated: ${changeText}`

    await notifyEventUpdate(userIds, eventTitle, message, eventId)
    logger.info("Event update notification sent", { eventId, recipientCount: userIds.length })
  } catch (error) {
    logger.error("Failed to send event update notification", { eventId, error: String(error) })
  }
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
      },
      select: {
        id: true,
        title: true,
        start_time: true,
        venue_name: true,
        favorites: {
          select: { user_id: true },
        },
      },
    })

    let totalNotified = 0

    for (const event of events) {
      const userIds = event.favorites.map((f) => f.user_id)
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
 * Notify interested users when an event is cancelled
 */
export async function notifyEventCancelled(
  eventId: string,
  eventTitle: string
): Promise<void> {
  try {
    const interested = await db.event_favorites.findMany({
      where: { event_id: eventId },
      select: { user_id: true },
    })

    if (interested.length === 0) return

    const userIds = interested.map((f) => f.user_id)
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
