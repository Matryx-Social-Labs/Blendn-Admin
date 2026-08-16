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

/**
 * How long *before* an event starts its room opens.
 *
 * The room used to have no lower bound at all: it was open from the moment the
 * group existed, which did not matter while the only way in was checking in —
 * you cannot check in to an event that has not started, so the floor was
 * implicit.
 *
 * Pre-event chat for people who RSVP'd removes that floor, and something has to
 * replace it. Without one, somebody who RSVPs to a festival three months out
 * sits in its chatroom for three months, and a room with no event around it is
 * just a public channel that happens to be named after a date.
 *
 * Twenty-four, mirroring the window on the other side. It is also the mitigation
 * for the weaker filter: an RSVP is a tap, where a check-in is a tap *at the
 * venue with GPS agreeing*, so the pre-event room admits a much broader group
 * than the live one. Bounding it to a day keeps that group small and keeps the
 * room about the event.
 */
export const PRE_EVENT_CHAT_HOURS = 24

export type ChatWindowState =
  | { open: true }
  | { open: false; reason: "archived" | "locked" | "window_closed" | "not_open_yet" }

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
  event: { start_time?: Date | null; end_time: Date },
  group: { status: chat_group_status },
  now: Date = new Date()
): ChatWindowState {
  if (group.status === "locked") return { open: false, reason: "locked" }
  if (group.status === "archived") return { open: false, reason: "archived" }

  const closesAt = new Date(event.end_time.getTime() + CHAT_WINDOW_HOURS * 60 * 60 * 1000)
  if (now >= closesAt) return { open: false, reason: "window_closed" }

  /*
   * The floor, and it is optional on purpose.
   *
   * `start_time` is newly read here, and several call sites select only
   * `end_time`. Treating a missing start as "no floor" keeps those callers
   * behaving exactly as they did rather than closing rooms they used to open --
   * a silent tightening is the worse failure, because it looks like the chat is
   * broken rather than like a rule.
   */
  if (event.start_time) {
    const opensAt = new Date(
      event.start_time.getTime() - PRE_EVENT_CHAT_HOURS * 60 * 60 * 1000
    )
    if (now < opensAt) return { open: false, reason: "not_open_yet" }
  }

  return { open: true }
}

/** Message shown to a client that tried to post into a closed room. */
export function chatClosedMessage(
  reason: "archived" | "locked" | "window_closed" | "not_open_yet"
): string {
  if (reason === "locked") return "This chat has been locked by the organiser"
  // Says when, not just no. "Closed" for a room that has never opened reads as
  // a fault, and the person asking is someone who RSVP'd and is keen.
  if (reason === "not_open_yet") return "This chat opens 24 hours before the event starts."
  return "This chat has closed. Event chats stay open for 24 hours after the event ends."
}

/** When a given event's chat closes — used by the cron and the dashboard. */
export function chatClosesAt(event: { end_time: Date }): Date {
  return new Date(event.end_time.getTime() + CHAT_WINDOW_HOURS * 60 * 60 * 1000)
}

/** Why a member cannot write. `null` from `mayWriteToRoom` means they can. */
export type WriteDenial =
  | { reason: "archived" | "locked" | "window_closed" | "not_open_yet" }
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
  event: { start_time?: Date | null; end_time: Date },
  group: { status: chat_group_status },
  now: Date = new Date()
): WriteDenial | null {
  if (membership.status === "banned") return { reason: "banned" }
  if (membership.status === "muted") return { reason: "muted" }

  const window = chatWindowState(event, group, now)
  if (!window.open) return { reason: window.reason }

  return null
}

/* -------------------------------------------------------------------------- */
/* Who may be in the room at all                                               */
/* -------------------------------------------------------------------------- */

/**
 * The two ways into an event's chatroom.
 *
 * `checked_in` is the strong one and was the only one: a tap **at the venue,
 * with GPS agreeing**. `rsvp` and `interested` are taps from anywhere, which is
 * the whole reason `PRE_EVENT_CHAT_HOURS` exists — see its note.
 */
export type RoomEntitlement = "checked_in" | "rsvp" | "interested" | null

/**
 * May this person join, and on what grounds?
 *
 * Split from the window check because they answer different questions and fail
 * differently. *"You have to be going to this"* and *"this opens tomorrow"* are
 * not the same refusal, and a room that gave one message for both would tell
 * somebody who RSVP'd that they are not welcome.
 *
 * Being checked in wins when both apply, so the roster and the audit trail
 * record the strongest claim rather than whichever was queried first.
 */
export function roomEntitlement(input: {
  checkedIn: boolean
  rsvpGoing: boolean
  interested: boolean
}): RoomEntitlement {
  if (input.checkedIn) return "checked_in"
  if (input.rsvpGoing) return "rsvp"
  if (input.interested) return "interested"
  return null
}

/**
 * Whether an entitlement is enough *right now*.
 *
 * Checking in is proof you are there, so it needs no calendar argument — and it
 * must not get one, or somebody standing in the venue of an event that started
 * early would be refused their own room.
 *
 * The weaker two are only good inside the pre-event window, which is what stops
 * an RSVP from being a permanent licence to a channel.
 */
export function entitlementAdmits(
  entitlement: RoomEntitlement,
  window: ChatWindowState
): boolean {
  if (!entitlement) return false
  if (entitlement === "checked_in") return true
  return window.open
}
