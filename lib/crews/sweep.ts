// Relative imports only, and nothing here may import lib/friends.ts or any
// module that uses the `@/` alias: the chat sweeper (lib/chat-lifecycle.ts)
// reaches this from server.ts, and plain tsc emits an alias verbatim into the
// require() (`server-import-boundary.test.ts`).
import type { Prisma } from "@prisma/client"

import { CREW } from "../constants"
import { db } from "../db"
import { logger } from "../logger"
import { closeRoomSockets } from "../room-close"

/**
 * A crew's standing: whether it still has enough people to be one, and an
 * owner who can act — the one place either is decided, for every writer that
 * can change it (a leave, a removal, an erasure, a suspension, a moderator)
 * and for the sweeper that repairs whatever one of them left behind.
 *
 * "People" means **active** members: not suspended, not erased. A suspended
 * member is on no crew surface (§6 Safety), so they neither keep a crew alive
 * nor hold it: a crew of two with one suspended dissolves (D-15), and a crew
 * whose owner is suspended passes to whoever has been in it longest. A
 * reinstated member does not get either back — dissolving is permanent, and
 * ownership is not a thing a suspension should be able to hold hostage.
 */

/** Active: not suspended, not erased. Spread into a `crew_members` filter. */
export const activeMemberWhere = { user: { suspended_at: null, deletedAt: null } } as const

/**
 * Serialise every change to one crew's membership for the caller's
 * transaction: a row lock on the crew. Counting members after this cannot race
 * another accept, leave or remove. Null for no such crew, or a dissolved one.
 *
 * Lock order, everywhere: the crew row first, then its room's rows.
 */
export async function lockCrew(
  tx: Prisma.TransactionClient,
  crewId: string
): Promise<{ id: string; name: string } | null> {
  const rows = await tx.$queryRaw<{ id: string; name: string }[]>`
    SELECT id::text, name FROM crews WHERE id = ${crewId}::uuid AND dissolved_at IS NULL FOR UPDATE`
  return rows[0] ?? null
}

/**
 * D-15, inside the caller's transaction holding the crew lock: `dissolved_at`,
 * every member and invite row gone, the room archived and everyone in it
 * released. The room id, for the caller to take the sockets out after commit.
 */
export async function dissolveLocked(tx: Prisma.TransactionClient, crewId: string): Promise<string | null> {
  const now = new Date()
  await tx.crews.update({ where: { id: crewId }, data: { dissolved_at: now, updated_at: now } })
  await tx.crew_members.deleteMany({ where: { crew_id: crewId } })
  await tx.crew_invites.deleteMany({ where: { crew_id: crewId } })
  const room = await tx.chat_groups.findUnique({ where: { crew_id: crewId }, select: { id: true } })
  if (!room) return null
  await tx.chat_groups.update({ where: { id: room.id }, data: { status: "archived" } })
  await tx.chat_group_members.updateMany({
    where: { chat_group_id: room.id, status: { in: ["active", "muted"] } },
    data: { status: "left" },
  })
  return room.id
}

/**
 * Settle a crew whose membership just changed, inside the caller's
 * transaction holding its lock: below `CREW.MIN_MEMBERS` active members it
 * dissolves; without an active owner, the longest-standing active member is
 * made owner (the old owner, if still a member, steps down first —
 * `crew_members_one_owner` allows one). Idempotent: a settled crew is left as
 * it is.
 */
export async function settleLocked(
  tx: Prisma.TransactionClient,
  crewId: string
): Promise<{ dissolved: boolean; roomId: string | null }> {
  const active = await tx.crew_members.findMany({
    where: { crew_id: crewId, ...activeMemberWhere },
    select: { user_id: true, role: true },
    orderBy: [{ joined_at: "asc" }, { user_id: "asc" }],
  })
  if (active.length < CREW.MIN_MEMBERS) return { dissolved: true, roomId: await dissolveLocked(tx, crewId) }
  if (!active.some((m) => m.role === "owner")) {
    await tx.crew_members.updateMany({ where: { crew_id: crewId, role: "owner" }, data: { role: "member" } })
    await tx.crew_members.update({
      where: { crew_id_user_id: { crew_id: crewId, user_id: active[0].user_id } },
      data: { role: "owner" },
    })
  }
  return { dissolved: false, roomId: null }
}

/** `settleLocked` in its own transaction, then the sockets out if it dissolved. */
export async function settleCrew(crewId: string): Promise<{ dissolved: boolean }> {
  const result = await db.$transaction(async (tx) => {
    if (!(await lockCrew(tx, crewId))) return { dissolved: false, roomId: null }
    return settleLocked(tx, crewId)
  })
  if (result.roomId) closeRoomSockets(result.roomId)
  return { dissolved: result.dissolved }
}

/**
 * Account erasure's second half (app/api/mobile/account). The erasure's own
 * transaction locks the person's crews, deletes their member rows (returning
 * which crews they were) and every invite to or from them; this settles each
 * of those crews after the commit. Never throws — the erasure has committed —
 * and a crew it fails to settle is repaired by the chat sweeper
 * (`repairCrews`), so nothing is left needing a person to notice.
 */
export async function settleCrewsAfterErasure(crewIds: readonly string[]): Promise<void> {
  for (const crewId of new Set(crewIds)) {
    try {
      await settleCrew(crewId)
    } catch (error) {
      logger.error("Settling a crew after an erasure failed; the sweeper will repair it", {
        crewId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

/** Bounded, like every sweeper pass. */
const REPAIR_BATCH = 200

/**
 * The sweeper's arm: every standing crew below two active members or without
 * an active owner, settled. Catches what a writer could not finish — an
 * erasure's settle that failed after its commit, a suspension (which writes
 * no crew row) — on the next pass.
 *
 * ponytail: a scan of every standing crew each pass, with two correlated
 * counts per crew. Cheap while crews number in the thousands; add a
 * `needs_settling` marker written by the suspension and erasure paths if a
 * pass ever shows up in the slow-query log.
 */
export async function repairCrews(): Promise<{ repaired: number; dissolved: number }> {
  const broken = await db.$queryRaw<{ id: string }[]>`
    SELECT c.id::text FROM crews c
    WHERE c.dissolved_at IS NULL AND (
      (SELECT count(*) FROM crew_members m JOIN "User" u ON u.id = m.user_id
        WHERE m.crew_id = c.id AND u.suspended_at IS NULL AND u."deletedAt" IS NULL) < ${CREW.MIN_MEMBERS}
      OR NOT EXISTS (SELECT 1 FROM crew_members m JOIN "User" u ON u.id = m.user_id
        WHERE m.crew_id = c.id AND m.role = 'owner' AND u.suspended_at IS NULL AND u."deletedAt" IS NULL)
    )
    LIMIT ${REPAIR_BATCH}`
  let dissolved = 0
  for (const { id } of broken) {
    if ((await settleCrew(id)).dissolved) dissolved++
  }
  return { repaired: broken.length, dissolved }
}

/**
 * A moderator's dissolve (C12, the reports queue): the crew ends as if its
 * last member had left (D-15), whatever its size. Inside the caller's
 * transaction, so the report's verdict and the dissolve commit together; the
 * room id comes back for the caller to take the sockets out after commit.
 * Null when it had already dissolved.
 */
export async function dissolveCrewLocked(
  tx: Prisma.TransactionClient,
  crewId: string
): Promise<{ roomId: string | null } | null> {
  if (!(await lockCrew(tx, crewId))) return null
  return { roomId: await dissolveLocked(tx, crewId) }
}
