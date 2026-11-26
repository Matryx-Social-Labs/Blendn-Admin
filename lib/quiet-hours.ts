// Relative imports: reached from server.ts through the reminder sweeper, and build:server emits `@/` verbatim.
import { formatInTimeZone } from "date-fns-tz"
import { db } from "./db"
import { eventClock } from "./event-phase"
import { nextLocalTime } from "./event-wall-clock"
import { logger } from "./logger"
import type { NotificationData } from "./push-notifications"

/** Quiet from 23:00 to 09:00 on the recipient's clock (launch gate 7, SCRUM-1276). */
export const QUIET_FROM_HOUR = 23
export const QUIET_UNTIL_HOUR = 9
/** The clock of somebody with no event on the push and no home city. */
export const FALLBACK_ZONE = "Asia/Kolkata"

/**
 * Kinds that ring at any hour: a person writing to you (a DM, a room reply, a request and its answer), a crew
 * arriving (one push per crew a night, owner 2026-11-14), and safety notices. Nightlife happens at night, and holding
 * a conversation breaks it.
 */
const ALWAYS_RINGS: ReadonlySet<NotificationData["type"]> = new Set<NotificationData["type"]>([
  "private_message",
  "group_message",
  "message_request",
  "message_request_response",
  "crew_here",
  "report_actioned",
  "board_post_removed",
])

export function isQuietAt(now: Date, timeZone: string): boolean {
  const hour = Number(formatInTimeZone(now, eventClock(timeZone).zone, "H"))
  return hour >= QUIET_FROM_HOUR || hour < QUIET_UNTIL_HOUR
}

/**
 * Who of `userIds` waits, and until when: the next 09:00 on their clock. Empty when everybody rings.
 *
 * Nobody out tonight is held. Exempt from every kind: an open check-in anywhere (lane advisor, 2026-11-26: a match,
 * a friend request or a wave between two people in the same room at 01:00 must ring). Exempt from a push about an
 * event: a `going` RSVP or any check-in row for that event. Never throws: a hold that cannot be decided is a push
 * sent, as today. `PUSH_QUIET_HOURS=off` turns the rule off without a deploy, and is what the test runners set so a
 * suite run at 01:00 IST still rings.
 */
export async function quietHolds(userIds: readonly string[], data: NotificationData | undefined, now = new Date()): Promise<Map<string, Date>> {
  if (process.env.PUSH_QUIET_HOURS === "off" || !data?.type || ALWAYS_RINGS.has(data.type) || userIds.length === 0) return new Map()
  try {
    const zoneOf = await zonesOf(userIds, data.eventId)
    const quiet = [...new Set(userIds)].filter((id) => isQuietAt(now, zoneOf(id)))
    if (quiet.length === 0) return new Map()
    const out = await outTonight(quiet, data.eventId)
    return new Map(quiet.filter((id) => !out.has(id)).map((id) => [id, nextLocalTime(now, zoneOf(id), QUIET_UNTIL_HOUR)]))
  } catch (error) {
    logger.warn("Quiet hours not decided; sending", { kind: data.type, error: error instanceof Error ? error.message : String(error) })
    return new Map()
  }
}

/**
 * The event's zone when the push names one, else the home city's, else `FALLBACK_ZONE`.
 * ponytail: a device time zone sent with the push token would be better (client BACKLOG); the home city is the
 * nearest thing the server holds today.
 */
async function zonesOf(userIds: readonly string[], eventId?: string): Promise<(userId: string) => string> {
  const event = eventId ? await db.events.findUnique({ where: { id: eventId }, select: { timezone: true } }) : null
  if (event?.timezone) return () => event.timezone
  const homes = await db.profiles.findMany({ where: { id: { in: [...userIds] } }, select: { id: true, home_city: { select: { timezone: true } } } })
  const zone = new Map(homes.map((p) => [p.id, p.home_city?.timezone]))
  return (userId) => zone.get(userId) ?? FALLBACK_ZONE
}

/** One read each, whatever the audience: an open check-in (the partial index `event_check_ins_one_open_per_user`) or a row for this event, and a `going` RSVP to it. */
async function outTonight(userIds: string[], eventId?: string): Promise<Set<string>> {
  const [checkIns, going] = await Promise.all([
    db.event_check_ins.findMany({
      where: { user_id: { in: userIds }, OR: [{ status: "checked_in" }, ...(eventId ? [{ event_id: eventId }] : [])] },
      select: { user_id: true },
    }),
    eventId
      ? db.event_rsvps.findMany({ where: { event_id: eventId, user_id: { in: userIds }, status: "going" }, select: { user_id: true } })
      : [],
  ])
  return new Set([...checkIns, ...going].map((r) => r.user_id))
}
