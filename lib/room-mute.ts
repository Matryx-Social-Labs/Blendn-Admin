import type { Prisma } from "@prisma/client"

/**
 * A person silencing a room for themselves.
 *
 * ## Not `member_status = 'muted'`
 *
 * That status is the organiser's or the pipeline's mute: it stops a person
 * **writing**. This is the opposite direction — the person stops the room
 * **ringing** — and it changes nothing about what they can read or post. The
 * two share a word and nothing else, so this one lives in
 * `chat_group_members.notification_preferences`, which has existed for exactly
 * this and had no reader.
 *
 * ```
 *   notification_preferences = { "muted": true, "muted_until": "<ISO>" | null }
 * ```
 *
 * `muted_until: null` is "until I turn it back on". A time in the past reads as
 * not muted, so an expired mute needs no sweeper to clear it.
 *
 * ## What it silences
 *
 * Every push the room sends to this member: a reply to them, and an organiser's
 * announcement. The bell row for an announcement goes with it — a mute that
 * still lit the badge would be half a mute. The room itself is untouched, and
 * the unread count on the Banter list still moves; that is not a notification.
 */
export interface RoomMute {
  muted: boolean
  /** ISO time the mute lapses; null when it lasts until turned off, or when not muted. */
  until: string | null
}

const NOT_MUTED: RoomMute = { muted: false, until: null }

function asObject(
  prefs: Prisma.JsonValue | Prisma.InputJsonObject | null | undefined
): Record<string, Prisma.JsonValue> {
  return prefs && typeof prefs === "object" && !Array.isArray(prefs)
    ? (prefs as Record<string, Prisma.JsonValue>)
    : {}
}

/** The mute as it stands at `now`. Tolerates any shape the column has ever held. */
export function roomMuteState(
  prefs: Prisma.JsonValue | Prisma.InputJsonObject | null | undefined,
  now: Date = new Date()
): RoomMute {
  const p = asObject(prefs)
  if (p.muted !== true) return NOT_MUTED
  const until = typeof p.muted_until === "string" ? p.muted_until : null
  if (until === null) return { muted: true, until: null }
  const at = Date.parse(until)
  // An unreadable time is treated as lapsed rather than as for ever: a mute
  // nobody can see the end of is worse than one that ended early.
  if (Number.isNaN(at) || at <= now.getTime()) return NOT_MUTED
  return { muted: true, until: new Date(at).toISOString() }
}

export function isRoomMuted(prefs: Prisma.JsonValue | null | undefined, now: Date = new Date()): boolean {
  return roomMuteState(prefs, now).muted
}

/** The column with the mute applied, every other key kept. */
export function withMute(
  prefs: Prisma.JsonValue | Prisma.InputJsonObject | null | undefined,
  until: Date | null
): Prisma.InputJsonObject {
  return { ...asObject(prefs), muted: true, muted_until: until ? until.toISOString() : null }
}

/** The column with the mute removed, every other key kept. */
export function withoutMute(
  prefs: Prisma.JsonValue | Prisma.InputJsonObject | null | undefined
): Prisma.InputJsonObject {
  const rest = { ...asObject(prefs) }
  delete rest.muted
  delete rest.muted_until
  return rest as Prisma.InputJsonObject
}
