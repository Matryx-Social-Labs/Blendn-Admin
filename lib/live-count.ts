import { db } from "@/lib/db"
import { LIVE_COUNT_BUCKETS, liveCountBucket, type LiveCountBucket } from "@/lib/disclosure"
import { venueDaysWhere } from "@/lib/event-kind"

/**
 * How many are live at a venue, as a watcher may see it (D-19, D-x2).
 *
 * A bucket alone still moves at its edges, and somebody polling the venue page
 * while a friend walks in can see the moment it moves. So the figure is also:
 *
 * - **Steady for a minute.** The count behind it is read at most once a
 *   minute per venue (`LIVE_COUNT_TTL_MS`), so an arrival shows up whenever
 *   the minute turns over, not when the person walks in.
 * - **Slow to fall.** It moves up at an edge, and down only once the count is
 *   a full person below it (`steadyBucket`), so one person stepping in and out
 *   at the edge does not flip it back and forth.
 * - **Not about you.** The caller is left out of the count they are shown,
 *   and only when that count included them: the cache keeps *who* it counted,
 *   so going live (or leaving) inside the minute moves nothing you see, and
 *   your own arrival cannot be used to find an edge (F14, step 2 review).
 *
 * Per process, in memory, like the rate limiter without Redis: more replicas
 * means more caches, each still a minute old at most.
 */

/** How long one venue's count is kept before it is read again. */
export const LIVE_COUNT_TTL_MS = 60_000

/**
 * The check-ins that are guests live at a venue now: a Go Live window still
 * open, by a guest — the venue's own people at work are not "people here".
 * The caller adds the venue day (`event: { ...venueDaysWhere, venue_id }`).
 * One definition for the venue page and the Places list, so the two never
 * count differently.
 */
export const liveGuestsWhere = (now: Date) => ({
  status: "checked_in" as const,
  expires_at: { gt: now },
  kind: "attendee" as const,
})

/**
 * Who is live at each of `venueIds` now: distinct people, guests only, one
 * read of `event_check_ins` for the whole list (it leads on `status,
 * expires_at`, which `@@index([status, expires_at])` serves). The venue page
 * and the Places list both count through here, so they cannot disagree.
 * The ids never leave the server.
 */
export async function liveGuestIds(venueIds: string[], now: Date): Promise<Map<string, Set<string>>> {
  const live = new Map(venueIds.map((id) => [id, new Set<string>()]))
  if (venueIds.length === 0) return live
  const rows = await db.event_check_ins.findMany({
    where: { ...liveGuestsWhere(now), event: { ...venueDaysWhere, venue_id: { in: venueIds } } },
    select: { user_id: true, event: { select: { venue_id: true } } },
  })
  for (const row of rows) if (row.event.venue_id) live.get(row.event.venue_id)?.add(row.user_id)
  return live
}

const rank = (b: LiveCountBucket) => LIVE_COUNT_BUCKETS.indexOf(b)

/** The bucket for `count`, falling below `prev` only when one more person would not hold it there. */
export function steadyBucket(prev: LiveCountBucket | null, count: number): LiveCountBucket {
  const now = liveCountBucket(count)
  if (!prev || rank(now) >= rank(prev)) return now
  return rank(liveCountBucket(count + 1)) < rank(prev) ? now : prev
}

type Entry = { ids: Set<string>; bucket: LiveCountBucket; at: number }
const shared = globalThis as typeof globalThis & { __blendnLiveCounts?: Map<string, Entry> }
const cache = (shared.__blendnLiveCounts ??= new Map<string, Entry>())

/**
 * The bucket to show `viewerId` for `venueId`: the venue's figure, at most a
 * minute old, less the viewer only if that figure counted them.
 */
export async function venueLiveBucket(
  venueId: string,
  viewerId: string | null,
  readIds: () => Promise<Set<string>>,
  nowMs: number = Date.now()
): Promise<LiveCountBucket> {
  let entry = cache.get(venueId)
  if (!entry || nowMs - entry.at >= LIVE_COUNT_TTL_MS) {
    const ids = await readIds()
    entry = { ids, bucket: steadyBucket(entry?.bucket ?? null, ids.size), at: nowMs }
    if (cache.size > 10_000) cache.clear()
    cache.set(venueId, entry)
  }
  /*
   * Somebody the figure counted reads the room's roster anyway, so theirs needs
   * no smoothing — only to leave them out, or the edge their own arrival
   * crossed would say how many others there are. Somebody it did not count
   * (they went live, or left, since it was read) sees it as it is: subtracting
   * them from a total read before they arrived is what showed N−1 (step 2 review).
   */
  if (viewerId && entry.ids.has(viewerId)) return liveCountBucket(entry.ids.size - 1)
  return entry.bucket
}
