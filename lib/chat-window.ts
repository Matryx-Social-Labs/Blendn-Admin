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

/** Why a member cannot write. `null` from `mayWriteToRoom` means they can. */
export type WriteDenial =
  | { reason: "archived" | "locked" | "window_closed" }
  | { reason: "muted" | "banned" }

/**
 * The one rule for whether a **member** may write to an event's room.
 *
 * ## The bug this exists to fix
 *
 * `chatWindowState` above says why the window exists: *"instead of emailing a
 * survey nobody fills in, you catch people while they are still **outside the
 * venue** with an opinion."*
 *
 * Check-out — manual or swept — set `chat_group_members.last_allowed_at = now`
 * (`lib/checkout.ts`), and both write paths refused anyone past that cutoff. So
 * the window designed to catch people *after they leave* was revoked *by them
 * leaving*. The 24-hour room had never worked for its stated purpose: the only
 * people who could post in it were the ones still standing at the venue.
 *
 * Worse during the event than after it. Auto-checkout fires at
 * `DEPARTURE_GRACE_MINUTES` (10) + `PROMPT_TIMEOUT_MINUTES` (10), so stepping
 * out for dinner, taking a call outside, or standing somewhere with bad GPS for
 * twenty minutes silenced you mid-conversation while the event was still on.
 *
 * ## Presence is not attendance
 *
 *   PRESENCE   are you here right now?   event_check_ins.status, left_area_at
 *              roster, grid, occupancy, the app's "Live now" rail
 *              volatile — flips on GPS, on a 20-minute absence, on a sweeper
 *
 *   ATTENDANCE were you ever here?       a chat_group_members row exists
 *              who is in the room
 *              permanent — written at check-in, never unwritten
 *
 * The room is safe because everyone in it **was physically co-present**, GPS
 * validated, at that venue. That is attendance. Leaving does not unsee what you
 * saw. The write gate was wired to presence, which is the whole bug.
 *
 * So membership is the attendance test, and presence is never consulted here.
 * `last_allowed_at` is deliberately **not read**: it records a departure, and a
 * departure is not a forfeit.
 *
 * ## Why one function rather than a check in each route
 *
 * The comment on `chatWindowState` records what happened last time this rule
 * lived in two places — an archived room stayed writable for months because the
 * two paths had drifted. Same failure, same fix: one rule, both callers.
 *
 * The drive-by (check in for thirty seconds, then troll the room anonymously for
 * a day) is accepted rather than defended against here. It costs a physical trip
 * to the venue and a GPS-validated check-in, and moderation, mute, ban and report
 * all still apply. A dwell minimum would have silenced the person who came, found
 * it too loud and left after five minutes — the one opinion the feedback window
 * most wants.
 */
export function mayWriteToRoom(
  membership: { status: string },
  event: { end_time: Date },
  group: { status: chat_group_status },
  now: Date = new Date()
): WriteDenial | null {
  if (membership.status === "banned") return { reason: "banned" }
  if (membership.status === "muted") return { reason: "muted" }

  const window = chatWindowState(event, group, now)
  if (!window.open) return { reason: window.reason }

  return null
}
