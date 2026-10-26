// Relative imports only: the check-out writer (lib/checkout.ts) reaches this, and the
// presence sweeper that runs it is part of the custom server's graph.
import { db } from "./db"
import { inRoomWhere } from "./event-kind"
import { logger } from "./logger"
import { friendsOf } from "./room-people"

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

/**
 * Loaded when there is something to send, not at import: `lib/friends.ts` reaches
 * this, and everything that imports friends (the unit suites, the sweepers) should
 * not pull the socket server and its auth stack with it.
 */
const emitRoomFriends = async (userIds: readonly string[], eventId: string) =>
  (await import("./socket-server")).emitRoomFriends(userIds, eventId)

/** Listable as "Friends here": opted in, "Show online status" on, not suspended or deleted. */
async function listable(userId: string): Promise<boolean> {
  const row = await db.user.findUnique({
    where: { id: userId },
    select: { suspended_at: true, deletedAt: true, profile: { select: { friends_see_me_in_rooms: true, show_online: true } } },
  })
  return !!row && !row.suspended_at && !row.deletedAt && row.profile?.friends_see_me_in_rooms === true && row.profile.show_online === true
}

/** The events this person is live in now. */
async function liveEventsOf(userId: string): Promise<string[]> {
  const rows = await db.event_check_ins.findMany({
    where: { user_id: userId, status: "checked_in", ...inRoomWhere() },
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
    // A check-in or checkout names its event (the subject may already be out of it); only a switch asks.
    const eventIds = opts.eventIds ? [...opts.eventIds] : await liveEventsOf(subjectId)
    if (eventIds.length === 0) return
    const friends = [...(await friendsOf(subjectId))]
    if (friends.length === 0) return
    const viewers = await db.event_check_ins.findMany({
      where: { user_id: { in: friends }, event_id: { in: eventIds }, status: "checked_in", ...inRoomWhere() },
      select: { user_id: true, event_id: true },
    })
    const byEvent = new Map<string, Set<string>>()
    for (const v of viewers) byEvent.set(v.event_id, (byEvent.get(v.event_id) ?? new Set()).add(v.user_id))
    for (const [eventId, ids] of byEvent) await emitRoomFriends([...ids], eventId)
  } catch (error) {
    logger.warn("room:friends signal failed", { error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * A friendship made or ended between two people: each is told, for the events both
 * are live in, that their Friends here moved, but only if the OTHER is listable for
 * them (a hidden friend's friendship changing signals nothing). After the commit.
 */
export async function notifyFriendshipChanged(a: string, b: string): Promise<void> {
  try {
    const [mine, theirs, aListable, bListable] = await Promise.all([liveEventsOf(a), liveEventsOf(b), listable(a), listable(b)])
    // `a`'s Friends here moves only if `b` is listable for them, and the other way round: a hidden
    // friend's friendship changing must tell nobody anything (neither is a signal about a stranger).
    const tell = [...(bListable ? [a] : []), ...(aListable ? [b] : [])]
    if (tell.length === 0) return
    const shared = mine.filter((e) => theirs.includes(e))
    for (const eventId of shared) await emitRoomFriends(tell, eventId)
  } catch (error) {
    logger.warn("room:friends signal failed", { error: error instanceof Error ? error.message : String(error) })
  }
}
