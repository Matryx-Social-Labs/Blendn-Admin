import { liveCountBucket, type LiveCountBucket } from "@/lib/disclosure"

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
 * - **Not about you.** The caller is left out of the count they are shown, so
 *   going live yourself cannot be used to find an edge.
 *
 * Per process, in memory, like the rate limiter without Redis: more replicas
 * means more caches, each still a minute old at most.
 */

/** How long one venue's count is kept before it is read again. */
export const LIVE_COUNT_TTL_MS = 60_000

const ORDER: readonly LiveCountBucket[] = ["quiet", "5-9", "10-19", "20+"]
const rank = (b: LiveCountBucket) => ORDER.indexOf(b)

/** The bucket for `count`, falling below `prev` only when one more person would not hold it there. */
export function steadyBucket(prev: LiveCountBucket | null, count: number): LiveCountBucket {
  const now = liveCountBucket(count)
  if (!prev || rank(now) >= rank(prev)) return now
  return rank(liveCountBucket(count + 1)) < rank(prev) ? now : prev
}

type Entry = { total: number; bucket: LiveCountBucket; at: number }
const shared = globalThis as typeof globalThis & { __blendnLiveCounts?: Map<string, Entry> }
const cache = (shared.__blendnLiveCounts ??= new Map<string, Entry>())

/**
 * The bucket to show `viewer` for `venueId`: the venue's count, at most a
 * minute old, less the viewer if they are one of the people live there.
 */
export async function venueLiveBucket(
  venueId: string,
  viewerIsLive: boolean,
  countLive: () => Promise<number>,
  nowMs: number = Date.now()
): Promise<LiveCountBucket> {
  let entry = cache.get(venueId)
  if (!entry || nowMs - entry.at >= LIVE_COUNT_TTL_MS) {
    const total = await countLive()
    entry = { total, bucket: steadyBucket(entry?.bucket ?? null, total), at: nowMs }
    if (cache.size > 10_000) cache.clear()
    cache.set(venueId, entry)
  }
  /*
   * Somebody live here reads the room's roster anyway, so their figure needs
   * no smoothing — only to leave them out: the venue's steady figure counts
   * them, and showing it to them would say, by the edge their own arrival
   * crossed, how many others there are.
   */
  if (viewerIsLive) return liveCountBucket(Math.max(0, entry.total - 1))
  return entry.bucket
}
