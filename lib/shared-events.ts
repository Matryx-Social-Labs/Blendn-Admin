import type { Prisma } from "@prisma/client"

import { conversationPair } from "./conversations"
import { db } from "./db"
import { realEventsWhere } from "./event-kind"
import { hostSideOf } from "./identity"
import { keysetPage, type Keyset } from "./pagination"

/**
 * "You've both been to" (SCRUM-1042, the person page's state 2 C): past events the viewer and this person were both
 * checked in to, newest first.
 *
 * ## Only where they were not a pseudonym to you
 *
 * A row says "this person was at X". If they were anonymous at X, anyone who sat in that room saw them as a pseudonym,
 * and the row would tie the pseudonym, and every message under it, to who they are. So an event is listed only when
 * the room itself would have named them to the viewer there, or they named themselves to the viewer from it:
 *
 * - **They revealed at X** (`event_match_preferences.revealed`): X's room names them to everyone in it.
 * - **They let friends recognise them in rooms**, and you are friends: their own standing consent, which X's roster
 *   applies too (`roomIdentity`).
 * - **They revealed to you in the conversation X's mutual like opened** (`origin_event_id`, their pseudonym set and
 *   their side revealed): you already know which pseudonym at X was them.
 *
 * And never:
 *
 * - **to the host side of X** (`hostSideOf`): an organiser or venue owner sees pseudonyms only, even of somebody who
 *   revealed in their own room;
 * - **across a block or a closed conversation**, in either direction: nothing at all;
 * - **a venue day** (`realEventsWhere`): its room names nobody to a viewer who has left, so a reveal after you left was
 *   never yours to see.
 *
 * This is the per-event half. Whether the viewer may know who the person is at all is `identityForRef`, asked by the
 * route first: a list for a handle that does not name them would tie that handle's pseudonym to every row.
 */
export interface SharedEvent {
  id: string
  title: string
  startTime: string
  timezone: string
  venueName: string | null
  coverImageUrl: string | null
}

const OPTED_IN = { select: { profile: { select: { friends_see_me_in_rooms: true } } } }
const ATTENDED = { kind: "attendee" as const, status: { in: ["checked_in" as const, "checked_out" as const] } }

/** The events this viewer may see this person at, or null when nothing is listable (yourself, a block, a closed pair). */
export async function sharedEventsWhere(viewerId: string, targetId: string, now: Date = new Date()): Promise<Prisma.eventsWhereInput | null> {
  if (viewerId === targetId) return null
  const [user1_id, user2_id] = conversationPair(viewerId, targetId)
  const [blocked, conversation, friendship] = await Promise.all([
    db.blocked_users.count({
      where: { OR: [{ blocker_id: viewerId, blocked_id: targetId }, { blocker_id: targetId, blocked_id: viewerId }] },
    }),
    db.private_conversations.findUnique({
      where: { user1_id_user2_id: { user1_id, user2_id } },
      select: { closed_at: true, origin_event_id: true, user1_pseudonym: true, user2_pseudonym: true, user1_revealed: true, user2_revealed: true },
    }),
    db.friendships.findUnique({
      where: { user1_id_user2_id: { user1_id, user2_id } },
      select: { user1: OPTED_IN, user2: OPTED_IN },
    }),
  ])
  if (blocked > 0 || conversation?.closed_at) return null

  const targetIs1 = targetId === user1_id
  // Directed: the TARGET's switch, never the viewer's.
  const friendSees = !!(targetIs1 ? friendship?.user1 : friendship?.user2)?.profile?.friends_see_me_in_rooms
  const dmEvent =
    conversation?.origin_event_id &&
    (targetIs1 ? conversation.user1_pseudonym : conversation.user2_pseudonym) !== null &&
    (targetIs1 ? conversation.user1_revealed : conversation.user2_revealed)
      ? conversation.origin_event_id
      : null

  const named: Prisma.eventsWhereInput[] = [
    { match_preferences: { some: { user_id: targetId, revealed: true } } },
    ...(dmEvent ? [{ id: dmEvent }] : []),
  ]
  return {
    ...realEventsWhere,
    deleted_at: null,
    end_time: { lt: now },
    AND: [
      { check_ins: { some: { user_id: viewerId, ...ATTENDED } } },
      { check_ins: { some: { user_id: targetId, ...ATTENDED } } },
      { NOT: hostSideOf(viewerId) },
      ...(friendSees ? [] : [{ OR: named }]),
    ],
  }
}

const NEWEST_FIRST = [{ start_time: "desc" as const }, { id: "desc" as const }]

/** One page of them, by `start_time DESC, id DESC`, with the whole count. */
export async function sharedEvents(
  viewerId: string,
  targetId: string,
  page: { limit: number; after: Keyset | null }
): Promise<{ events: SharedEvent[]; hasMore: boolean; nextCursor: string | null; totalCount: number }> {
  const where = await sharedEventsWhere(viewerId, targetId)
  if (!where) return { events: [], hasMore: false, nextCursor: null, totalCount: 0 }
  const k = page.after
  const after: Prisma.eventsWhereInput = k?.at ? { OR: [{ start_time: { lt: k.at } }, { start_time: k.at, id: { lt: k.id } }] } : {}
  const [rows, totalCount] = await Promise.all([
    db.events.findMany({
      where: { AND: [where, after] },
      orderBy: NEWEST_FIRST,
      take: page.limit + 1,
      select: { id: true, title: true, start_time: true, timezone: true, venue_name: true, cover_image_url: true, venue: { select: { name: true } } },
    }),
    db.events.count({ where }),
  ])
  const { items, hasMore, nextCursor } = keysetPage(rows, page.limit, (e) => ({ at: e.start_time, id: e.id }))
  return {
    hasMore,
    nextCursor,
    totalCount,
    events: items.map((e) => ({
      id: e.id,
      title: e.title,
      startTime: e.start_time.toISOString(),
      timezone: e.timezone,
      venueName: e.venue?.name ?? e.venue_name ?? null,
      coverImageUrl: e.cover_image_url,
    })),
  }
}
