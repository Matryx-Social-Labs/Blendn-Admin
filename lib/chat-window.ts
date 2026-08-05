import type { chat_group_status } from "@prisma/client"

/**
 * How long an event's chatroom stays open after the event ends.
 *
 * The window is deliberate product design, not leniency: instead of emailing a
 * survey nobody fills in, you catch people while they are still outside the
 * venue with an opinion. After it closes the room is archived and nobody can
 * post again.
 */
export const CHAT_WINDOW_HOURS = 24

export type ChatWindowState =
  | { open: true }
  | { open: false; reason: "archived" | "locked" | "window_closed" }

/**
 * The one rule for whether an event chatroom accepts writes.
 *
 * This exists because there were two write paths with two different gates, and
 * they had drifted:
 *
 *   events/[eventId]/chat            rejected anything not `active`
 *   chat/groups/[id]/messages        rejected only `locked`
 *
 * So the second path let anyone post to an *archived* room indefinitely — a
 * membership row from an event months ago was still a licence to write, because
 * nothing on that path ever looked at the calendar. Exactly the shape of the
 * `canManageEvent` / `canModerateChat` contradiction: one rule, two
 * implementations, silently disagreeing.
 *
 * Both paths now call this, so the rule cannot fork again.
 *
 * The time check is deliberately independent of the archive flag. Archiving is
 * a background job and jobs are late, get stuck, or have never run for a given
 * row; a room whose event ended three months ago must be closed on the strength
 * of its own end time whether or not anything got round to flagging it.
 */
export function chatWindowState(
  event: { end_time: Date },
  group: { status: chat_group_status },
  now: Date = new Date()
): ChatWindowState {
  if (group.status === "locked") return { open: false, reason: "locked" }
  if (group.status === "archived") return { open: false, reason: "archived" }

  const closesAt = new Date(event.end_time.getTime() + CHAT_WINDOW_HOURS * 60 * 60 * 1000)
  if (now >= closesAt) return { open: false, reason: "window_closed" }

  return { open: true }
}

/** Message shown to a client that tried to post into a closed room. */
export function chatClosedMessage(reason: "archived" | "locked" | "window_closed"): string {
  if (reason === "locked") return "This chat has been locked by the organiser"
  return "This chat has closed. Event chats stay open for 24 hours after the event ends."
}

/** When a given event's chat closes — used by the cron and the dashboard. */
export function chatClosesAt(event: { end_time: Date }): Date {
  return new Date(event.end_time.getTime() + CHAT_WINDOW_HOURS * 60 * 60 * 1000)
}
