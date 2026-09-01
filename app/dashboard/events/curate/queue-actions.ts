"use server"

import { getAuth } from "@/lib/auth"
import { CURATION_PAGE, curationSelect } from "@/lib/curation"
import { db } from "@/lib/db"

export interface CuratedEventRow {
  id: string
  title: string
  city: string | null
  startsAt: string
  ended: boolean
  sourceUrl: string | null
  /** Distinct people who actually got in. */
  checkedIn: number
  /** Distinct people turned away at the door. */
  refused: number
  /** Metres, median. A tight cluster is a pin on the wrong side of the street. */
  medianShortfall: number | null
  /** Claims filed, any status. */
  claims: number
  claimed: boolean
}

/**
 * Curation health: is what we added actually check-in-able?
 *
 * ## The one number
 *
 * A curated event that **ended with zero check-ins**. It is the only figure
 * that catches a wrong pin, a wrong time or a dead listing, and nothing else
 * will — all three produce identical silence.
 *
 * What separates them is whether anybody *tried*. Zero check-ins and zero
 * refusals is a listing nobody wanted. Zero check-ins and eleven refusals is a
 * pin in the wrong place, and the median shortfall says which kind of wrong:
 * everybody twenty metres out is one street; a wide spread is a fence too tight.
 *
 * None of that was observable before `check_in_refusals`, because a refused
 * check-in produced a 400 and no record.
 */
/** Rows plus the total, so a capped screen can say it is capped. */
export interface CurationQueue {
  rows: CuratedEventRow[]
  /** Every curated event matching the filter, including the ones not returned. */
  total: number
}

export async function getCurationQueue(city?: string): Promise<CurationQueue> {
  const session = await getAuth()
  if (session?.user?.role !== "app_admin") throw new Error("Not authorised")

  const where = {
    curated_at: { not: null },
    deleted_at: null,
    ...(city ? { city: { equals: city, mode: "insensitive" as const } } : {}),
  }

  /*
   * The total, alongside the page.
   *
   * `take: 100` with nothing saying so is a silent cap, and an admin reading a
   * hundred rows and believing that is all of them concludes curation is
   * healthier than it is. The same "no silent caps" rule this codebase applies
   * to every bounded backend query, applied to the screen that shows the result.
   */
  const total = await db.events.count({ where })

  const events = await db.events.findMany({
    where,
    orderBy: { start_time: "desc" },
    take: CURATION_PAGE,
    select: { id: true, title: true, city: true, source_url: true, ...curationSelect },
  })
  if (events.length === 0) return { rows: [], total }

  const ids = events.map((e) => e.id)

  /*
   * People, not rows, on both sides.
   *
   * One person trying four times from the pavement is one person with a
   * problem, and counting attempts would make them look like a crowd. The
   * check-in side is the same rule `lib/counting.ts` documents across nine
   * other call sites -- `event_check_ins` holds one row per person per day.
   */
  const [checkIns, refusals, claims] = await Promise.all([
    db.event_check_ins.findMany({
      where: { event_id: { in: ids }, status: { in: ["checked_in", "checked_out"] }, kind: "attendee" },
      select: { event_id: true, user_id: true },
    }),
    db.check_in_refusals.findMany({
      where: { event_id: { in: ids } },
      select: { event_id: true, user_id: true, shortfall_metres: true },
      take: 5_000,
    }),
    db.event_claims.groupBy({
      by: ["event_id"],
      where: { event_id: { in: ids } },
      _count: { _all: true },
    }),
  ])

  const attended = new Map<string, Set<string>>()
  for (const c of checkIns) {
    const set = attended.get(c.event_id) ?? new Set<string>()
    set.add(c.user_id)
    attended.set(c.event_id, set)
  }

  const turnedAway = new Map<string, Set<string>>()
  const shortfalls = new Map<string, number[]>()
  for (const r of refusals) {
    const set = turnedAway.get(r.event_id) ?? new Set<string>()
    set.add(r.user_id)
    turnedAway.set(r.event_id, set)
    if (r.shortfall_metres !== null) {
      shortfalls.set(r.event_id, [...(shortfalls.get(r.event_id) ?? []), r.shortfall_metres])
    }
  }

  const claimCount = new Map(claims.map((c) => [c.event_id, c._count._all]))
  const now = Date.now()

  const rows = events.map((e) => {
    const s = (shortfalls.get(e.id) ?? []).sort((a, b) => a - b)
    return {
      id: e.id,
      title: e.title,
      city: e.city,
      startsAt: e.start_time.toISOString(),
      ended: e.end_time.getTime() < now,
      sourceUrl: e.source_url,
      checkedIn: attended.get(e.id)?.size ?? 0,
      refused: turnedAway.get(e.id)?.size ?? 0,
      medianShortfall: s.length === 0 ? null : s[Math.floor((s.length - 1) / 2)],
      claims: claimCount.get(e.id) ?? 0,
      claimed: e.claimed_at !== null,
    }
  })

  return { rows, total }
}
