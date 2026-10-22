import type { Prisma } from "@prisma/client"

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

type FriendReader = Pick<Prisma.TransactionClient, "friendships">
type BlockReader = Pick<Prisma.TransactionClient, "blocked_users" | "private_conversations">

/** Everyone who must never appear to `viewerId` as a stranger: their friends. */
export async function notStrangersTo(viewerId: string, client: FriendReader = db): Promise<Set<string>> {
  const rows = await client.friendships.findMany({
    where: { OR: [{ user1_id: viewerId }, { user2_id: viewerId }] },
    select: { user1_id: true, user2_id: true },
  })
  return new Set(rows.map((r) => (r.user1_id === viewerId ? r.user2_id : r.user1_id)))
}

/** Pair form, for the write routes. Under the pair's lock when it decides a write: pass the transaction. */
export async function knownToEachOther(a: string, b: string, client: FriendReader = db): Promise<boolean> {
  if (a === b) return false
  const row = await client.friendships.findFirst({
    where: { OR: [{ user1_id: a, user2_id: b }, { user1_id: b, user2_id: a }] },
    select: { id: true },
  })
  return row !== null
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
  const [apart, friends] = await Promise.all([
    blocksBetween(A, B, client),
    client.friendships.findMany({
      where: { OR: [{ user1_id: { in: A }, user2_id: { in: B } }, { user1_id: { in: B }, user2_id: { in: A } }] },
      select: { user1_id: true, user2_id: true },
    }),
  ])
  const pairs = friends.flatMap((f) => [`${f.user1_id}|${f.user2_id}`, `${f.user2_id}|${f.user1_id}`])
  return new Set([...apart, ...pairs])
}
