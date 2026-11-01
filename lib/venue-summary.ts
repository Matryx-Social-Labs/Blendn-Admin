import type { venue_type } from "@prisma/client"

import { db } from "@/lib/db"
import { liveVenueIds, listedVenuesWhere, openTonightVenueIds, upcomingEventsWhere } from "@/lib/venue-listing"
import type { CityRule } from "@/lib/browse-scope"
import { venuesTakenOver } from "@/lib/venue-visibility"
import { venueTypeLabel } from "@/lib/venue-types"

/** How long one summary is kept per scope, like the live count's minute. */
const SUMMARY_TTL_MS = 60_000
/** The most areas one summary lists: the busiest first, so the cut drops the quietest. */
export const SUMMARY_AREAS_MAX = 100
/** The venue types drawn in an area's mosaic. */
const TYPE_MIX_SIZE = 4

export interface VenueSummary {
  total: number
  liveCount: number
  openTonightCount: number
  types: { venueType: venue_type; label: string; count: number }[]
  areas: { slug: string; name: string; count: number; liveCount: number; typeMix: venue_type[] }[]
}

const shared = globalThis as typeof globalThis & { __blendnVenueSummary?: Map<string, { value: VenueSummary; at: number }> }
const cache = (shared.__blendnVenueSummary ??= new Map())

type Viewer = { userId: string; viewerAge: number | null; mayCountLive: boolean; cityRule: CityRule }

/**
 * Counts of places, never of people, for one city: how many venues Places
 * lists, how many are live or open tonight, and the split by type and by area.
 *
 * The same set the list returns (`listedVenuesWhere`, then the takeover rule
 * for this viewer's age), so "12 places" never sits over a list of 10. The
 * split is **one grouped query**; live and open tonight are the list's own
 * reads (`liveVenueIds`, `openTonightVenueIds`), the first only for somebody
 * the venue page would answer, as `liveNow` is.
 *
 * Kept 60 s per city rule, per viewer age and per whether the viewer may count
 * live: the three things that change the answer. The viewer who fills an entry
 * is the one `liveVenueIds` leaves out of the count, so a venue sitting on the
 * edge of a bucket can differ by one person between two readers; the figure is
 * a count of venues and says nothing about who.
 */
export async function venueSummary(viewer: Viewer, now: Date): Promise<VenueSummary> {
  const key = JSON.stringify({ city: viewer.cityRule, age: viewer.viewerAge, live: viewer.mayCountLive })
  const hit = cache.get(key)
  if (hit && now.getTime() - hit.at < SUMMARY_TTL_MS) return hit.value

  const where = listedVenuesWhere(viewer.cityRule)
  const taken = await venuesTakenOver(now, where, { viewerAge: viewer.viewerAge })
  if (taken.length > 0) where.id = { notIn: taken }

  const groups = await db.venues.groupBy({
    by: ["venue_type", "area", "area_slug"],
    where,
    _count: { _all: true },
  })

  const live = viewer.mayCountLive ? await liveVenueIds(where, viewer.userId, now) : new Set<string>()
  const tonight = await openTonightVenueIds(
    where,
    upcomingEventsWhere(viewer.viewerAge, now),
    now,
    live,
    JSON.stringify({ summary: true, city: viewer.cityRule, age: viewer.viewerAge, live: viewer.mayCountLive })
  )
  const liveByArea =
    live.size === 0
      ? []
      : await db.venues.groupBy({ by: ["area_slug"], where: { AND: [where, { id: { in: [...live] } }] }, _count: { _all: true } })

  const value = summarise(groups, new Map(liveByArea.map((g) => [g.area_slug, g._count._all])), live.size, tonight.size)
  if (cache.size > 1000) cache.clear()
  cache.set(key, { value, at: now.getTime() })
  return value
}

type Group = { venue_type: venue_type | null; area: string | null; area_slug: string | null; _count: { _all: number } }

/** The grouped rows as the response: pure, so the shapes can be tested without a database. */
export function summarise(
  groups: Group[],
  liveBySlug: ReadonlyMap<string | null, number>,
  liveCount: number,
  openTonightCount: number
): VenueSummary {
  const byType = new Map<venue_type, number>()
  const byArea = new Map<string, { name: string; count: number; mix: Map<venue_type, number> }>()
  let total = 0
  for (const g of groups) {
    const n = g._count._all
    total += n
    if (g.venue_type) byType.set(g.venue_type, (byType.get(g.venue_type) ?? 0) + n)
    if (!g.area_slug || !g.area) continue
    const area = byArea.get(g.area_slug) ?? { name: g.area, count: 0, mix: new Map() }
    area.count += n
    if (g.venue_type) area.mix.set(g.venue_type, (area.mix.get(g.venue_type) ?? 0) + n)
    byArea.set(g.area_slug, area)
  }
  const mostFirst = <T extends string>(m: ReadonlyMap<T, number>) =>
    [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  return {
    total,
    liveCount,
    openTonightCount,
    types: mostFirst(byType).map(([venueType, count]) => ({ venueType, label: venueTypeLabel(venueType), count })),
    areas: [...byArea]
      .map(([slug, a]) => ({
        slug,
        name: a.name,
        count: a.count,
        liveCount: liveBySlug.get(slug) ?? 0,
        typeMix: mostFirst(a.mix).slice(0, TYPE_MIX_SIZE).map(([t]) => t),
      }))
      .sort((a, b) => b.liveCount - a.liveCount || b.count - a.count || (a.slug < b.slug ? -1 : 1))
      .slice(0, SUMMARY_AREAS_MAX),
  }
}
