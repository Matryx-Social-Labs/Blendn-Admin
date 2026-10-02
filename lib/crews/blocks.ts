// Relative imports only (see lib/crews/sweep.ts): the block writers and the
// sweeper both reach this.
import type { Prisma } from "@prisma/client"

import { db } from "../db"

/**
 * Who is kept apart, for every crew surface (plan v2 §6 Safety).
 *
 * Two people are kept apart when either blocked the other, **or** when a
 * conversation between them was closed — an unmatch is permanent ("you won't
 * see each other in rooms again", SCRUM-113), so a crew card, a crew like, a
 * crew invite or a Blend that put them back in front of each other would undo
 * it (PR #630/#631 security review, C6).
 */

type Reader = Pick<Prisma.TransactionClient, "blocked_users" | "private_conversations">

/**
 * Pairs (a, b) kept apart, as `a|b` keys both ways, for these two sets. Two
 * reads however large the sets. Pass the transaction to read under its locks.
 */
export async function blocksBetween(
  as: readonly string[],
  bs: readonly string[],
  client: Reader = db
): Promise<Set<string>> {
  if (as.length === 0 || bs.length === 0) return new Set()
  const [A, B] = [[...as], [...bs]]
  const [blocks, closed] = await Promise.all([
    client.blocked_users.findMany({
      where: { OR: [{ blocker_id: { in: A }, blocked_id: { in: B } }, { blocker_id: { in: B }, blocked_id: { in: A } }] },
      select: { blocker_id: true, blocked_id: true },
    }),
    client.private_conversations.findMany({
      where: {
        closed_at: { not: null },
        OR: [{ user1_id: { in: A }, user2_id: { in: B } }, { user1_id: { in: B }, user2_id: { in: A } }],
      },
      select: { user1_id: true, user2_id: true },
    }),
  ])
  const pairs = [...blocks.map((r) => [r.blocker_id, r.blocked_id]), ...closed.map((c) => [c.user1_id, c.user2_id])]
  return new Set(pairs.flatMap(([x, y]) => [`${x}|${y}`, `${y}|${x}`]))
}

/**
 * Whether any member of one side is kept apart from any member of the other
 * (CR-U04): either direction, any pair, not only the person asking. Pure.
 */
export function blocksExclude(sideA: readonly string[], sideB: readonly string[], blocked: ReadonlySet<string>): boolean {
  return sideA.some((a) => sideB.some((b) => blocked.has(`${a}|${b}`)))
}

/**
 * The crew invites between two people, either way, gone — for a block and for
 * an unfriend (C5). An invite is a friend asking; once they are not friends,
 * or one has blocked the other, it is not an ask anybody should be able to
 * accept. A removal marker (`removed_at`) is not an invite and stays: it is
 * the owner's word that this person is out.
 *
 * Called inside the writer's own transaction, by every writer of
 * `blocked_users` and by both unfriend paths (`crew-block-writers.test.ts`).
 */
export async function dropCrewInvitesBetween(
  client: Pick<Prisma.TransactionClient, "crew_invites">,
  a: string,
  b: string
): Promise<void> {
  await client.crew_invites.deleteMany({
    where: {
      removed_at: null,
      OR: [
        { invited_by: a, invited_user_id: b },
        { invited_by: b, invited_user_id: a },
      ],
    },
  })
}
