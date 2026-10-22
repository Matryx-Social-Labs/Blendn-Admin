import { db } from "@/lib/db"
import { conversationPair } from "@/lib/conversations"
import { holdingPair, matchSelect, personCard, personSelect } from "@/lib/friends"
import { inRoomWhere } from "@/lib/event-kind"
import { friendsOf } from "@/lib/room-people"

/**
 * "Friends here": the viewer's friends at this event who let friends see them,
 * by REAL id (the owner's rule, 2026-10-22, plans/friends-in-room.md). They are
 * on no stranger surface (`lib/room-people.ts`); this is the one place a friend
 * appears in a room, and it carries no event, room or arrival time.
 *
 * A friend F is listed for viewer V when all hold: V has a live check-in there
 * (the route's gate); F is V's friend; F has a `checked_in` attendee check-in
 * (staff never: they are working) in the live window; F turned on `friends_see_me_in_rooms`
 * AND `show_online` ("Show online status" off means don't list me, D10); F is not
 * suspended or deleted; and the pair is not still pseudonymous in a match
 * (`holdingPair`, D12: Message would be a 409).
 *
 * Three reads whatever the size, no N+1 (plan 4.3): the friends, their check-ins
 * (with the profile filter in the query), and their conversations. The set is at
 * most the viewer's friend count and is sorted and sliced in memory.
 * ponytail: a viewer with thousands of friends puts thousands of ids in one IN,
 * fine for Postgres; move it into SQL with a join past ~10k friends.
 */

export const FRIENDS_HERE_DEFAULT_LIMIT = 8
export const FRIENDS_HERE_MAX_LIMIT = 50
export const FRIENDS_HERE_MAX_QUERY = 40

export type FriendsHereOrder = "recent" | "name"

export interface FriendHere {
  userId: string
  name: string
  photo: string | null
}

export interface FriendsHerePage {
  friends: FriendHere[]
  /** Every friend listed for the viewer here, not only this page. */
  total: number
  nextCursor: string | null
}

interface Row {
  card: FriendHere
  /** The friend DM's last message, for `recent`: the people you actually talk to come first. */
  talkedAt: number
  arrivedAt: number
}

const sortKey = (name: string) => name.toLocaleLowerCase()
const encode = (name: string, id: string) => Buffer.from(JSON.stringify([sortKey(name), id])).toString("base64url")

function decode(cursor: string): [string, string] | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown
    return Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string" ? [parsed[0], parsed[1]] : null
  } catch {
    return null
  }
}

/** Case-insensitive prefix of any word of the name. */
const matches = (name: string, q: string) => name.toLocaleLowerCase().split(/\s+/).some((word) => word.startsWith(q))

export class BadCursor extends Error {}

export async function friendsHere(
  eventId: string,
  viewerId: string,
  opts: { order: FriendsHereOrder; limit: number; cursor?: string; q?: string }
): Promise<FriendsHerePage> {
  // Friends only: an ex-friend of the last 24 h is off the stranger surfaces, but is not listed here.
  const friendIds = [...(await friendsOf(viewerId))]
  if (friendIds.length === 0) return { friends: [], total: 0, nextCursor: null }

  const checkIns = await db.event_check_ins.findMany({
    where: {
      event_id: eventId,
      user_id: { in: friendIds },
      status: "checked_in",
      kind: "attendee",
      ...inRoomWhere(),
      user: {
        suspended_at: null,
        deletedAt: null,
        profile: { is: { friends_see_me_in_rooms: true, show_online: true } },
      },
    },
    select: { user_id: true, check_in_time: true, user: { select: personSelect } },
    orderBy: { check_in_time: "desc" },
  })
  if (checkIns.length === 0) return { friends: [], total: 0, nextCursor: null }

  // One row per person: a multi-day event can hold more than one live row; newest first, so the first wins.
  const latest = new Map<string, (typeof checkIns)[number]>()
  for (const c of checkIns) if (!latest.has(c.user_id)) latest.set(c.user_id, c)
  const present = [...latest.keys()]

  const pairs = present.map((id) => conversationPair(viewerId, id))
  const conversations = await db.private_conversations.findMany({
    where: { OR: pairs.map(([user1_id, user2_id]) => ({ user1_id, user2_id })) },
    select: { last_message_at: true, ...matchSelect },
  })
  const talkedAt = new Map<string, { at: number; holding: boolean; closed: boolean }>()
  for (const c of conversations) {
    const other = c.user1_id === viewerId ? c.user2_id : c.user1_id
    talkedAt.set(other, { at: c.last_message_at?.getTime() ?? 0, holding: holdingPair(c), closed: c.closed_at !== null })
  }

  let rows: Row[] = present
    // A closed DM (an unmatch) or a pseudonymous one: Message would be a 409.
    .filter((id) => !talkedAt.get(id)?.holding && !talkedAt.get(id)?.closed)
    .map((id) => {
      const c = latest.get(id)!
      return { card: personCard(c.user), talkedAt: talkedAt.get(id)?.at ?? 0, arrivedAt: c.check_in_time?.getTime() ?? 0 }
    })

  const q = opts.order === "name" ? opts.q?.trim().toLocaleLowerCase() : undefined
  if (q) rows = rows.filter((r) => matches(r.card.name, q))
  const total = rows.length

  if (opts.order === "recent") {
    rows.sort((a, b) => b.talkedAt - a.talkedAt || b.arrivedAt - a.arrivedAt || a.card.userId.localeCompare(b.card.userId))
    return { friends: rows.slice(0, opts.limit).map((r) => r.card), total, nextCursor: null }
  }

  // By name, with a cursor on (lower(name), id): a strict order, so a friend who arrives mid-read neither repeats nor leaves a gap.
  rows.sort((a, b) => {
    const [x, y] = [sortKey(a.card.name), sortKey(b.card.name)]
    return x < y ? -1 : x > y ? 1 : a.card.userId < b.card.userId ? -1 : 1
  })
  let start = 0
  if (opts.cursor) {
    const after = decode(opts.cursor)
    if (!after) throw new BadCursor()
    start = rows.findIndex((r) => {
      const key = sortKey(r.card.name)
      return key > after[0] || (key === after[0] && r.card.userId > after[1])
    })
    if (start === -1) start = rows.length
  }
  const page = rows.slice(start, start + opts.limit)
  const last = page[page.length - 1]
  return {
    friends: page.map((r) => r.card),
    total,
    nextCursor: last && start + opts.limit < rows.length ? encode(last.card.name, last.card.userId) : null,
  }
}
