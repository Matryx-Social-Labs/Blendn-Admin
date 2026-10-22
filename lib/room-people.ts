import type { Prisma } from "@prisma/client"

import { conversationPair } from "./conversations"
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
