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
    // A checkout: the subject is already out, so the events are the caller's.
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

/** Subjects per read in `notifyFriendsHereMany`: bounds the IN lists (a person's friends times this). */
const FRIENDS_SIGNAL_CHUNK = 500

/**
 * `notifyFriendsHere` for a batch of departures (the sweepers'), in three reads
 * per chunk of people rather than four per person: who is listable, their
 * friendships, and which of those friends are live at the same events. A room
 * hears one `room:friends` per event with everyone it concerns -- the signal
 * is "refetch", so one per person or one for the lot is the same to a phone.
 */
export async function notifyFriendsHereMany(departures: readonly { userId: string; eventId: string }[]): Promise<void> {
  try {
    for (let i = 0; i < departures.length; i += FRIENDS_SIGNAL_CHUNK) {
      await notifyChunk(departures.slice(i, i + FRIENDS_SIGNAL_CHUNK))
    }
  } catch (error) {
    logger.warn("room:friends signal failed", { error: error instanceof Error ? error.message : String(error) })
  }
}

async function notifyChunk(departures: readonly { userId: string; eventId: string }[]): Promise<void> {
  const subjects = [...new Set(departures.map((d) => d.userId))]
  const people = await db.user.findMany({
    where: { id: { in: subjects } },
    select: { id: true, suspended_at: true, deletedAt: true, profile: { select: { friends_see_me_in_rooms: true, show_online: true } } },
  })
  const listed = new Set(
    people
      .filter((p) => !p.suspended_at && !p.deletedAt && p.profile?.friends_see_me_in_rooms === true && p.profile.show_online === true)
      .map((p) => p.id)
  )
  if (listed.size === 0) return
  const rows = await db.friendships.findMany({
    where: { OR: [{ user1_id: { in: [...listed] } }, { user2_id: { in: [...listed] } }] },
    select: { user1_id: true, user2_id: true },
  })
  const friendsOfSubject = new Map<string, Set<string>>()
  for (const r of rows) {
    if (listed.has(r.user1_id)) friendsOfSubject.set(r.user1_id, (friendsOfSubject.get(r.user1_id) ?? new Set()).add(r.user2_id))
    if (listed.has(r.user2_id)) friendsOfSubject.set(r.user2_id, (friendsOfSubject.get(r.user2_id) ?? new Set()).add(r.user1_id))
  }
  const departed = departures.filter((d) => friendsOfSubject.has(d.userId))
  if (departed.length === 0) return
  const viewers = await db.event_check_ins.findMany({
    where: {
      user_id: { in: [...new Set(departed.flatMap((d) => [...friendsOfSubject.get(d.userId)!]))] },
      event_id: { in: [...new Set(departed.map((d) => d.eventId))] },
      status: "checked_in",
      ...inRoomWhere(),
    },
    select: { user_id: true, event_id: true },
  })
  const liveAt = new Set(viewers.map((v) => `${v.event_id}:${v.user_id}`))
  const toTell = new Map<string, Set<string>>()
  for (const d of departed) {
    for (const friend of friendsOfSubject.get(d.userId)!) {
      if (liveAt.has(`${d.eventId}:${friend}`)) toTell.set(d.eventId, (toTell.get(d.eventId) ?? new Set()).add(friend))
    }
  }
  for (const [eventId, ids] of toTell) await emitRoomFriends([...ids], eventId)
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
