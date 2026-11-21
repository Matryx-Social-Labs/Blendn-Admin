// Relative imports throughout — see lib/conversations.ts.
import { db } from "../db"
import { paginationMeta, paginationSkip, type PaginationMeta, type PaginationParams } from "../pagination"
import { blocksBetween, blocksExclude } from "./blocks"
import { NO_CREW, type CrewRefusal } from "./crews"
import { membersOf } from "./presence"

/**
 * "Block" on a crew (owner 2026-11-13): hide that crew from YOU for good. Never
 * a block of its members, and only the hider: the crew is not told, its
 * members' accounts are untouched, your crewmates still see it, and a Mix it
 * makes with your crew opens for you as for everyone (decided per advisor,
 * 2026-11-21). What it takes away: its card in every room (`crewsAtEvent`)
 * and your own like or wave at it (`likeCrew`: the same 404 as a crew not
 * there). "Hide this crew tonight" is the app's alone and never reaches here.
 * Undone from Settings → Blocked (`GET /crews/hidden`, `DELETE …/hide`).
 */

export async function hidesCrew(userId: string, crewId: string): Promise<boolean> {
  return (await db.crew_hides.count({ where: { user_id: userId, crew_id: crewId } })) > 0
}

/** The crews this person hid, of `crewIds`: one indexed read for a room's worth. */
export async function hiddenOf(userId: string, crewIds: readonly string[]): Promise<Set<string>> {
  if (crewIds.length === 0) return new Set()
  const rows = await db.crew_hides.findMany({ where: { user_id: userId, crew_id: { in: [...crewIds] } }, select: { crew_id: true } })
  return new Set(rows.map((r) => r.crew_id))
}

/** The crews of `crewIds` with anybody kept apart from `userId` (a block or a closed conversation, either way). */
async function keptApartCrews(userId: string, crewIds: readonly string[]): Promise<Set<string>> {
  const members = await membersOf(crewIds)
  const blocked = await blocksBetween([userId], [...new Set([...members.values()].flat())])
  return new Set([...members].filter(([, ids]) => blocksExclude([userId], ids, blocked)).map(([id]) => id))
}

/**
 * Hide a standing crew you are not in. Hiding twice is hiding once. A crew with
 * anybody kept apart from you is the 404 of a crew not there: the door must not
 * confirm a crew the cards would never show you (security review of #1003).
 */
export async function hideCrew(userId: string, crewId: string): Promise<{ hidden: true } | CrewRefusal> {
  const crew = await db.crews.findFirst({
    where: { id: crewId, dissolved_at: null, members: { none: { user_id: userId } } },
    select: { id: true },
  })
  if (!crew || (await keptApartCrews(userId, [crewId])).size > 0) return NO_CREW
  await db.crew_hides.createMany({ data: [{ user_id: userId, crew_id: crewId }], skipDuplicates: true })
  return { hidden: true }
}

/** Show it again. Undoing one you never hid is a no-op, not a refusal: nothing about the crew is said. */
export async function unhideCrew(userId: string, crewId: string): Promise<{ hidden: false }> {
  await db.crew_hides.deleteMany({ where: { user_id: userId, crew_id: crewId } })
  return { hidden: false }
}

export interface HiddenCrew {
  crewId: string
  name: string
  emblemSeed: string
  hiddenAt: string
}

/**
 * Settings → Blocked: the crews you hid, newest first, a page at a time. A crew
 * that has ended is not listed, and neither is one with anybody now kept apart
 * from you: its name is not yours to read. ponytail: that one is dropped from
 * the page after the count, so a page can come back short; filter in SQL if
 * blocked people ever pile up in hidden crews.
 */
export async function hiddenCrews(userId: string, page: PaginationParams): Promise<{ crews: HiddenCrew[]; pagination: PaginationMeta }> {
  const where = { user_id: userId, crew: { dissolved_at: null } }
  const [total, rows] = await Promise.all([
    db.crew_hides.count({ where }),
    db.crew_hides.findMany({
      where,
      orderBy: [{ created_at: "desc" }, { crew_id: "desc" }],
      skip: paginationSkip(page.page, page.limit),
      take: page.limit,
      select: { created_at: true, crew: { select: { id: true, name: true, emblem_seed: true } } },
    }),
  ])
  const apart = await keptApartCrews(userId, rows.map((r) => r.crew.id))
  return {
    crews: rows.filter((r) => !apart.has(r.crew.id)).map((r) => ({ crewId: r.crew.id, name: r.crew.name, emblemSeed: r.crew.emblem_seed, hiddenAt: r.created_at.toISOString() })),
    pagination: paginationMeta(page.page, page.limit, total),
  }
}
