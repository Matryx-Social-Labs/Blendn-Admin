// Relative imports only: the check-out writer (lib/checkout.ts) reaches this, and the
// presence sweeper that runs it is part of the custom server's graph.
import { db } from "./db"
import { inRoomWhere } from "./event-kind"
import { logger } from "./logger"
import { notStrangersTo } from "./room-people"
import { emitRoomFriends } from "./socket-server"

/**
 * `room:friends`: "your Friends here changed, refetch". Content-free (`{ eventId }`)
 * and sent only to the people it can concern, never to the room: bounded by a
 * person's friend count, not by the audience (plans/friends-in-room.md 4.4).
 *
 * A hidden friend's movements fire nothing to anybody: a signal timed to a
 * check-in would say that somebody who is not listed arrived.
 *
 * Fire and forget, and logged: a signal never fails the write that caused it.
 */

/** Listable as "Friends here": opted in, "Show online status" on, not suspended or deleted. */
async function listable(userId: string): Promise<boolean> {
  const row = await db.user.findUnique({
    where: { id: userId },
    select: { suspended_at: true, deletedAt: true, profile: { select: { friends_see_me_in_rooms: true, show_online: true } } },
  })
  return !!row && !row.suspended_at && !row.deletedAt && row.profile?.friends_see_me_in_rooms === true && row.profile.show_online === true
}

/** The events this person is live in now. */
async function liveEventsOf(userId: string, eventIds?: readonly string[]): Promise<string[]> {
  const rows = await db.event_check_ins.findMany({
    where: { user_id: userId, status: "checked_in", ...(eventIds && { event_id: { in: [...eventIds] } }), ...inRoomWhere() },
    select: { event_id: true },
    distinct: ["event_id"],
  })
  return rows.map((r) => r.event_id)
}

/**
 * Tell the friends of `subjectId` who are live at the same event(s) that their
 * Friends here moved: a check-in, a checkout, a switch. `force` skips the
 * listable test, for a switch that just turned a person OFF (the viewers who had
 * them must refetch to drop them: the caller sends it only when either the old or
 * the new state was listable).
 */
export async function notifyFriendsHere(subjectId: string, opts: { eventIds?: readonly string[]; force?: boolean } = {}): Promise<void> {
  try {
    if (!opts.force && !(await listable(subjectId))) return
    const events = await liveEventsOf(subjectId, opts.eventIds)
    // A checkout: the subject is already out, so the events are the caller's.
    const eventIds = opts.eventIds ? [...opts.eventIds] : events
    if (eventIds.length === 0) return
    const friends = [...(await notStrangersTo(subjectId))]
    if (friends.length === 0) return
    const viewers = await db.event_check_ins.findMany({
      where: { user_id: { in: friends }, event_id: { in: eventIds }, status: "checked_in", ...inRoomWhere() },
      select: { user_id: true, event_id: true },
    })
    const byEvent = new Map<string, Set<string>>()
    for (const v of viewers) byEvent.set(v.event_id, (byEvent.get(v.event_id) ?? new Set()).add(v.user_id))
    for (const [eventId, ids] of byEvent) emitRoomFriends([...ids], eventId)
  } catch (error) {
    logger.warn("room:friends signal failed", { error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * A friendship made or ended between two people: each tells the other, for the
 * events both are live in, that their Friends here moved. After the commit.
 */
export async function notifyFriendshipChanged(a: string, b: string): Promise<void> {
  try {
    const [mine, theirs] = await Promise.all([liveEventsOf(a), liveEventsOf(b)])
    const shared = mine.filter((e) => theirs.includes(e))
    for (const eventId of shared) emitRoomFriends([a, b], eventId)
  } catch (error) {
    logger.warn("room:friends signal failed", { error: error instanceof Error ? error.message : String(error) })
  }
}
