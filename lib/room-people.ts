import type { Prisma } from "@prisma/client"

import { blockCounterparties, blockCounterpartiesMany, closedPairKeys, conversationPair } from "./conversations"
import { blocksBetween } from "./crews/blocks"
import { db } from "./db"

// Relative imports only (see lib/crews/blocks.ts): the socket server and the
// crew sweeper reach this, and the custom server's graph may not touch `@/`.

/**
 * "Not a stranger to me" — the one question every room people-surface asks.
 *
 * The owner's rule (2026-10-22, plans/friends-in-room.md): two friends never meet
 * as strangers. A friend is never a card, a face, a row, a wave, a like, a match,
 * a crew or Blend across, a board post or a rating to the other, anywhere in a
 * room. A friend who turned on "Friends can see I'm here" is in "Friends here"
 * (its own endpoint, by real id); one who did not is, to you, exactly what someone
 * with "Show online status" off already is: counted, listed nowhere.
 *
 * This file is the set form (for lists), the pair form (for the write routes: a
 * like, a wave, a message request, a board ask) and the two-sides form (crews,
 * Blends, board seating). A guard test fails the build when a listed people
 * surface does not reference it (`people-surfaces-exclude-friends.test.ts`).
 */

/**
 * The roster's visibility rule as a `user` filter: "Show online status" off is
 * counted, listed nowhere, and so not likeable either (SCRUM-669). `is: null`
 * because a missing profile row must not read as "off". The wave route and the
 * room preview spell the same clause inline.
 */
export const LISTED_IN_ROSTER = { OR: [{ profile: { is: null } }, { profile: { show_online: true } }] } satisfies Prisma.UserWhereInput

type FriendReader = Pick<Prisma.TransactionClient, "friendships" | "ended_friendships">

/** How long an ended friendship keeps the pair apart: the longest a room stays open (D17). */
export const ENDED_FRIENDSHIP_HOURS = 24
const endedSince = () => new Date(Date.now() - ENDED_FRIENDSHIP_HOURS * 3600_000)
type BlockReader = Pick<Prisma.TransactionClient, "blocked_users" | "private_conversations">

/**
 * `viewerId`'s friends and nothing else: the friendships half of `notStrangersTo`,
 * without the 24 h of an ended one. For "Friends here" and the signals that
 * carry it: an ex-friend is kept off the STRANGER surfaces for a day, but is not a
 * friend, so they are not listed there and are never told it moved.
 */
export async function friendsOf(viewerId: string, client: Pick<Prisma.TransactionClient, "friendships"> = db): Promise<Set<string>> {
  const rows = await client.friendships.findMany({
    where: { OR: [{ user1_id: viewerId }, { user2_id: viewerId }] },
    select: { user1_id: true, user2_id: true },
  })
  return new Set(rows.map((r) => (r.user1_id === viewerId ? r.user2_id : r.user1_id)))
}

/**
 * Everyone who must never appear to `viewerId` as a stranger: their friends, and
 * anyone whose friendship ended in the last 24 hours (B4: an unfriend must not
 * put the ex-friend's stranger card in front of the other at that moment).
 */
export async function notStrangersTo(viewerId: string, client: FriendReader = db): Promise<Set<string>> {
  const where = { OR: [{ user1_id: viewerId }, { user2_id: viewerId }] }
  const [friends, ended] = await Promise.all([
    client.friendships.findMany({ where, select: { user1_id: true, user2_id: true } }),
    client.ended_friendships.findMany({ where: { ...where, ended_at: { gt: endedSince() } }, select: { user1_id: true, user2_id: true } }),
  ])
  return new Set([...friends, ...ended].map((r) => (r.user1_id === viewerId ? r.user2_id : r.user1_id)))
}

/** `notStrangersTo` for several viewers in two reads: each viewer's set, by id. */
export async function notStrangersToMany(viewerIds: readonly string[], client: FriendReader = db): Promise<Map<string, Set<string>>> {
  const ids = new Set(viewerIds)
  const where = { OR: [{ user1_id: { in: [...ids] } }, { user2_id: { in: [...ids] } }] }
  const [friends, ended] = await Promise.all([
    client.friendships.findMany({ where, select: { user1_id: true, user2_id: true } }),
    client.ended_friendships.findMany({ where: { ...where, ended_at: { gt: endedSince() } }, select: { user1_id: true, user2_id: true } }),
  ])
  const byViewer = new Map<string, Set<string>>([...ids].map((id) => [id, new Set<string>()]))
  for (const r of [...friends, ...ended]) {
    if (ids.has(r.user1_id)) byViewer.get(r.user1_id)!.add(r.user2_id)
    if (ids.has(r.user2_id)) byViewer.get(r.user2_id)!.add(r.user1_id)
  }
  return byViewer
}

/**
 * Who `viewerId` never sees in a room, on any list of its people (SCRUM-1386):
 * anybody in a block with them either way, anybody they closed a conversation
 * with (an unmatch is permanent), every friend (`notStrangersTo`), and anybody
 * they reported (SCRUM-229: a block on the reporter's side, without blocking;
 * any status, so a closed report does not bring the person back and tell the
 * reporter the outcome; one direction, so the reported person is told nothing).
 *
 * ONE list because a list that hides fewer people than the deck lets the viewer
 * diff the two and single out the handle of the person they unmatched or
 * reported. The deck, the roster, the participants list, the night's people,
 * the wave lists and the room preview all ask this
 * (`people-surfaces-exclude-friends.test.ts`); a pair check is `.has(id)`.
 */
export async function hiddenInRooms(viewerId: string): Promise<Set<string>> {
  const [blocked, closed, friends, reported] = await Promise.all([
    blockCounterparties(viewerId),
    closedPairKeys(viewerId),
    notStrangersTo(viewerId),
    db.user_reports.findMany({ where: { reporter_id: viewerId }, select: { reported_id: true }, distinct: ["reported_id"] }),
  ])
  return new Set([...blocked, ...closed, ...friends, ...reported.map((r) => r.reported_id)])
}

/**
 * `hiddenInRooms` turned round, for a push about these people (an arrival, a
 * departure): for each, the viewers whose lists leave them out. The same four
 * reasons, so a copy never names somebody the recipient's roster hides; the
 * report is read from the other end (who reported THEM). Five reads however
 * many people.
 */
export async function viewersHiddenFromMany(userIds: readonly string[]): Promise<Map<string, Set<string>>> {
  const ids = [...new Set(userIds)]
  const [friends, blocked, closed, reports] = await Promise.all([
    notStrangersToMany(ids),
    blockCounterpartiesMany(ids),
    db.private_conversations.findMany({
      where: { closed_at: { not: null }, OR: [{ user1_id: { in: ids } }, { user2_id: { in: ids } }] },
      select: { user1_id: true, user2_id: true },
    }),
    db.user_reports.findMany({ where: { reported_id: { in: ids } }, select: { reporter_id: true, reported_id: true }, distinct: ["reporter_id", "reported_id"] }),
  ])
  const byUser = new Map(ids.map((id) => [id, new Set([...(friends.get(id) ?? []), ...(blocked.get(id) ?? [])])]))
  for (const r of closed) {
    byUser.get(r.user1_id)?.add(r.user2_id)
    byUser.get(r.user2_id)?.add(r.user1_id)
  }
  for (const r of reports) byUser.get(r.reported_id)?.add(r.reporter_id)
  return byUser
}

/** Pair form, for the write routes. Under the pair's lock when it decides a write: pass the transaction. */
export async function knownToEachOther(a: string, b: string, client: FriendReader = db): Promise<boolean> {
  if (a === b) return false
  const pair = { OR: [{ user1_id: a, user2_id: b }, { user1_id: b, user2_id: a }] }
  const [friends, ended] = await Promise.all([
    client.friendships.findFirst({ where: pair, select: { id: true } }),
    client.ended_friendships.findFirst({ where: { ...pair, ended_at: { gt: endedSince() } }, select: { ended_at: true } }),
  ])
  return friends !== null || ended !== null
}

/** The row `unfriend` writes: this pair's friendship ended now. Idempotent, and a later unfriend overwrites. */
export async function recordEndedFriendship(client: Pick<Prisma.TransactionClient, "ended_friendships">, a: string, b: string): Promise<void> {
  const [user1_id, user2_id] = conversationPair(a, b)
  await client.ended_friendships.upsert({
    where: { user1_id_user2_id: { user1_id, user2_id } },
    create: { user1_id, user2_id },
    update: { ended_at: new Date() },
  })
}

/**
 * Pairs (x, y) kept apart across two sides, as `x|y` keys both ways: blocks, a
 * closed conversation (what `blocksBetween` answers) AND a friendship. For
 * crews, Blends and board seating, where a friend across the two sides would be a
 * stranger to the other inside a pseudonymous room. Three reads however large
 * the sets; pass the transaction to read under its locks.
 *
 * Not a change to `blocksBetween`: crew invites and membership REQUIRE a
 * friendship and use it.
 */
export async function strangersApartBetween(
  as: readonly string[],
  bs: readonly string[],
  client: BlockReader & FriendReader = db
): Promise<Set<string>> {
  if (as.length === 0 || bs.length === 0) return new Set()
  const [A, B] = [[...as], [...bs]]
  const across = { OR: [{ user1_id: { in: A }, user2_id: { in: B } }, { user1_id: { in: B }, user2_id: { in: A } }] }
  const [apart, friendships, ended] = await Promise.all([
    blocksBetween(A, B, client),
    client.friendships.findMany({ where: across, select: { user1_id: true, user2_id: true } }),
    client.ended_friendships.findMany({ where: { ...across, ended_at: { gt: endedSince() } }, select: { user1_id: true, user2_id: true } }),
  ])
  const pairs = [...friendships, ...ended].flatMap((f) => [`${f.user1_id}|${f.user2_id}`, `${f.user2_id}|${f.user1_id}`])
  return new Set([...apart, ...pairs])
}
