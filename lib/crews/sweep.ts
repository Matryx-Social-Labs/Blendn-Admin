// Relative imports only, and nothing here may import lib/friends.ts or any
// module that uses the `@/` alias: the chat sweeper (lib/chat-lifecycle.ts)
// reaches this from server.ts, and plain tsc emits an alias verbatim into the
// require() (`server-import-boundary.test.ts`).
import type { Prisma } from "@prisma/client"

import { CREW } from "../constants"
import { db } from "../db"
import { logger } from "../logger"
import { closeRoomSockets } from "../room-close"
import { OWNER_ROOM_HOURS } from "../room-kind"

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
): Promise<{ id: string; name: string; hidden: boolean } | null> {
  const rows = await tx.$queryRaw<{ id: string; name: string; hidden: boolean }[]>`
    SELECT id::text, name, hidden_at IS NOT NULL AS hidden FROM crews WHERE id = ${crewId}::uuid AND dissolved_at IS NULL FOR UPDATE`
  return rows[0] ?? null
}

/** Rooms archived and everyone in them released, inside the caller's transaction. */
async function archiveRooms(tx: Prisma.TransactionClient, roomIds: readonly string[]): Promise<void> {
  if (roomIds.length === 0) return
  await tx.chat_groups.updateMany({ where: { id: { in: [...roomIds] }, status: "active" }, data: { status: "archived" } })
  await tx.chat_group_members.updateMany({
    where: { chat_group_id: { in: [...roomIds] }, status: { in: ["active", "muted"] } },
    data: { status: "left" },
  })
}

/**
 * Every open Blend this crew is a side of, closed now (`closed_at`), its room
 * archived and released: a crew that dissolves, or that a moderator hides,
 * takes its Blends with it. Inside the caller's transaction; the room ids
 * come back for the sockets after commit.
 */
export async function closeCrewBlendsLocked(tx: Prisma.TransactionClient, crewId: string): Promise<string[]> {
  const open = await tx.blends.findMany({
    where: { closed_at: null, OR: [{ a_crew_id: crewId }, { b_crew_id: crewId }] },
    select: { id: true, room: { select: { id: true } } },
  })
  if (open.length === 0) return []
  await tx.blends.updateMany({ where: { id: { in: open.map((b) => b.id) }, closed_at: null }, data: { closed_at: new Date() } })
  const roomIds = open.flatMap((b) => (b.room ? [b.room.id] : []))
  await archiveRooms(tx, roomIds)
  return roomIds
}

/**
 * D-15, inside the caller's transaction holding the crew lock: `dissolved_at`,
 * every member and invite row gone, the crew's room archived and everyone in
 * it released, and its open Blends closed. The room ids, for the caller to
 * take the sockets out after commit.
 */
export async function dissolveLocked(tx: Prisma.TransactionClient, crewId: string): Promise<string[]> {
  const now = new Date()
  await tx.crews.update({ where: { id: crewId }, data: { dissolved_at: now, updated_at: now } })
  await tx.crew_members.deleteMany({ where: { crew_id: crewId } })
  await tx.crew_invites.deleteMany({ where: { crew_id: crewId } })
  const room = await tx.chat_groups.findUnique({ where: { crew_id: crewId }, select: { id: true } })
  const roomIds = room ? [room.id] : []
  await archiveRooms(tx, roomIds)
  return [...roomIds, ...(await closeCrewBlendsLocked(tx, crewId))]
}

/**
 * Settle a crew whose membership just changed, inside the caller's
 * transaction holding its lock: below `CREW.MIN_MEMBERS` active members it
 * dissolves; without an active owner, the longest-standing active member who
 * owns fewer than `CREW.MAX_OWNED` crews is made owner (the old owner, if still a member, steps down first —
 * `crew_members_one_owner` allows one). Idempotent: a settled crew is left as
 * it is.
 */
export async function settleLocked(
  tx: Prisma.TransactionClient,
  crewId: string,
  opts: { graceWhileInviting?: boolean } = {}
): Promise<{ dissolved: boolean; roomIds: string[] }> {
  const active = await tx.crew_members.findMany({
    where: { crew_id: crewId, ...activeMemberWhere },
    select: { user_id: true, role: true },
    orderBy: [{ joined_at: "asc" }, { user_id: "asc" }],
  })
  const waiting = opts.graceWhileInviting && active.length >= 1 && (await waitingOnInvites(tx, crewId))
  if (active.length < CREW.MIN_MEMBERS && !waiting) return { dissolved: true, roomIds: await dissolveLocked(tx, crewId) }
  if (!active.some((m) => m.role === "owner")) {
    // The longest-standing active member who can take another crew under the
    // cap (`CREW.MAX_OWNED`); only if nobody can, the longest-standing anyway —
    // a crew must have an owner, and nobody is made to leave one.
    const owned = await tx.crew_members.groupBy({
      by: ["user_id"],
      where: { user_id: { in: active.map((m) => m.user_id) }, role: "owner", crew: { dissolved_at: null } },
      _count: { _all: true },
    })
    const full = new Set(owned.filter((o) => o._count._all >= CREW.MAX_OWNED).map((o) => o.user_id))
    const heir = active.find((m) => !full.has(m.user_id)) ?? active[0]
    await tx.crew_members.updateMany({ where: { crew_id: crewId, role: "owner" }, data: { role: "member" } })
    await tx.crew_members.update({
      where: { crew_id_user_id: { crew_id: crewId, user_id: heir.user_id } },
      data: { role: "owner" },
    })
  }
  return { dissolved: false, roomIds: [] }
}

/**
 * A crew of one still waiting on its friends: it has an invite somebody can
 * still say yes to, or it is younger than an invite lives (`CREW.INVITE_TTL_MS`).
 * Every crew starts as one person and its invites (step 9 review, C1): the
 * sweeper's repair must not dissolve it before anybody has had the chance to
 * accept. A departure is not this — a crew somebody leaves down to one still
 * dissolves at once (D-15); only the sweeper gives the grace.
 */
async function waitingOnInvites(tx: Prisma.TransactionClient, crewId: string): Promise<boolean> {
  const since = new Date(Date.now() - CREW.INVITE_TTL_MS)
  const [young, open] = await Promise.all([
    tx.crews.count({ where: { id: crewId, created_at: { gt: since } } }),
    tx.crew_invites.count({ where: { crew_id: crewId, declined_at: null, removed_at: null, created_at: { gt: since } } }),
  ])
  return young + open > 0
}

/** `settleLocked` in its own transaction, then the sockets out if it dissolved. */
export async function settleCrew(crewId: string, opts: { graceWhileInviting?: boolean } = {}): Promise<{ dissolved: boolean }> {
  const result = await db.$transaction(async (tx) => {
    if (!(await lockCrew(tx, crewId))) return { dissolved: false, roomIds: [] }
    return settleLocked(tx, crewId, opts)
  })
  for (const id of result.roomIds) closeRoomSockets(id)
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
 * no crew row) — on the next pass. Never a crew of one still waiting on its
 * invites (`waitingOnInvites`): a new crew is its owner and the friends it
 * asked, and dissolving it at the next sweep turned every accept that came
 * later than fifteen minutes into a 404 (step 9 review, C1).
 *
 * ponytail: a scan of every standing crew each pass, with two correlated
 * counts per crew. Cheap while crews number in the thousands; add a
 * `needs_settling` marker written by the suspension and erasure paths if a
 * pass ever shows up in the slow-query log.
 */
export async function repairCrews(): Promise<{ repaired: number; dissolved: number }> {
  const broken = await crewsToRepair()
  let dissolved = 0
  for (const id of broken) {
    if ((await settleCrew(id, { graceWhileInviting: true })).dissolved) dissolved++
  }
  return { repaired: broken.length, dissolved }
}

/**
 * The crews `repairCrews` settles this pass. A waiting crew is left out here,
 * not only by the settle: one picked up every pass would fill the batch, and a
 * crew that really is broken would wait behind two hundred that are not.
 */
export async function crewsToRepair(): Promise<string[]> {
  const ttl = CREW.INVITE_TTL_MS / 1000
  const broken = await db.$queryRaw<{ id: string }[]>`
    WITH standing AS (
      SELECT c.id, c.created_at,
        (SELECT count(*) FROM crew_members m JOIN "User" u ON u.id = m.user_id
          WHERE m.crew_id = c.id AND u.suspended_at IS NULL AND u."deletedAt" IS NULL) AS active,
        EXISTS (SELECT 1 FROM crew_members m JOIN "User" u ON u.id = m.user_id
          WHERE m.crew_id = c.id AND m.role = 'owner' AND u.suspended_at IS NULL AND u."deletedAt" IS NULL) AS has_owner,
        EXISTS (SELECT 1 FROM crew_invites i WHERE i.crew_id = c.id AND i.declined_at IS NULL AND i.removed_at IS NULL
          AND i.created_at > now() - make_interval(secs => ${ttl})) AS open_invite
      FROM crews c WHERE c.dissolved_at IS NULL
    )
    SELECT id::text FROM standing
    WHERE (active < ${CREW.MIN_MEMBERS}
            AND NOT (active >= 1 AND (open_invite OR created_at > now() - make_interval(secs => ${ttl}))))
       OR (active >= 1 AND NOT has_owner)
    LIMIT ${REPAIR_BATCH}`
  return broken.map((r) => r.id)
}

/**
 * A moderator's dissolve (C12, the reports queue): the crew ends as if its
 * last member had left (D-15), whatever its size, and its open Blends close.
 * Inside the caller's transaction, so the report's verdict and the dissolve
 * commit together; the room ids come back for the sockets after commit.
 * Null when it had already dissolved.
 */
export async function dissolveCrewLocked(
  tx: Prisma.TransactionClient,
  crewId: string
): Promise<{ roomIds: string[] } | null> {
  if (!(await lockCrew(tx, crewId))) return null
  return { roomIds: await dissolveLocked(tx, crewId) }
}

/**
 * Crew likes that never made a Blend, gone once their night is over: 12 hours
 * after the occurrence ends (`OWNER_ROOM_HOURS`, when a Blend from it would
 * have closed). A like that went nowhere is somebody's unanswered interest,
 * with the name of the member who tapped it (`liked_by_user_id`); kept past
 * the night it is only something to leak. A like that made a Blend stays with
 * the Blend it explains. Bounded per pass, like every sweeper arm.
 */
export async function purgeLapsedCrewLikes(): Promise<number> {
  return db.$executeRaw`
    DELETE FROM crew_likes WHERE id IN (
      SELECT l.id FROM crew_likes l
      JOIN event_occurrences o ON o.id = l.occurrence_id
      WHERE o.end_time < now() - make_interval(hours => ${OWNER_ROOM_HOURS})
        AND NOT EXISTS (
          SELECT 1 FROM blends b WHERE b.occurrence_id = l.occurrence_id AND (
            (l.to_crew_id IS NOT NULL AND l.from_crew_id IS NOT NULL
              AND b.a_crew_id = LEAST(l.from_crew_id, l.to_crew_id) AND b.b_crew_id = GREATEST(l.from_crew_id, l.to_crew_id))
            OR (l.to_user_id IS NOT NULL AND b.a_crew_id = l.from_crew_id AND b.b_user_id = l.to_user_id)
            OR (l.from_user_id IS NOT NULL AND b.a_crew_id = l.to_crew_id AND b.b_user_id = l.from_user_id)
          )
        )
      LIMIT ${REPAIR_BATCH * 5}
    )`
}
