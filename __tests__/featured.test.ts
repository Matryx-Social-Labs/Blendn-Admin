import { EDITORIAL_BY, FEATURED_MAX, featuredKind, featuredOf, featuredSeed, rotated } from "@/lib/featured"
import { buildEventsCacheKey } from "@/lib/events-cache-key"
import { eventQuerySchema } from "@/lib/validations/event"

/**
 * C1 (home panes): `featured: { kind, rank, by } | null` on the events list.
 * Today the only source is the admin-set `is_featured`; the shape is what a paid
 * `promoted` kind will fit without a client change.
 */
const at = (iso: string) => new Date(iso)
const ev = (id: string, is_featured: boolean) => ({ id, is_featured })

describe("featuredKind", () => {
  it("is editorial for an admin pick and null for everything else", () => {
    expect(featuredKind({ is_featured: true })).toBe("editorial")
    expect(featuredKind({ is_featured: false })).toBeNull()
  })
})

describe("featuredSeed", () => {
  it("is the day and the city, the city as the filter reads it", () => {
    const now = at("2026-10-21T08:00:00Z")
    expect(featuredSeed("Bengaluru", now)).toBe("2026-10-21|bengaluru")
    expect(featuredSeed(" bengaluru ", now)).toBe(featuredSeed("Bengaluru", now))
    expect(featuredSeed(undefined, now)).toBe("2026-10-21|")
    expect(featuredSeed("Bengaluru", at("2026-10-22T08:00:00Z"))).not.toBe(featuredSeed("Bengaluru", now))
  })
})

describe("rotated", () => {
  const ids = Array.from({ length: 12 }, (_, i) => ({ id: `evt-${i}` }))
  const order = (seed: string, list = ids) => rotated(list, seed).map((e) => e.id)

  it("is the same order for everyone on one day in one city, whatever order they were read in", () => {
    const seed = "2026-10-21|bengaluru"
    expect(order(seed, [...ids].reverse())).toEqual(order(seed))
    expect(order(seed)).toHaveLength(12)
  })

  it("turns over with the day and differs by city", () => {
    expect(order("2026-10-21|bengaluru")).not.toEqual(order("2026-10-22|bengaluru"))
    expect(order("2026-10-21|bengaluru")).not.toEqual(order("2026-10-21|mumbai"))
  })

  it("does not mutate what it was given", () => {
    const copy = [...ids]
    rotated(ids, "x")
    expect(ids).toEqual(copy)
  })

  it("gives every event the lead on some day: no pick is stuck at the bottom", () => {
    const leaders = new Set(
      Array.from({ length: 60 }, (_, d) => order(`2026-11-${String(d + 1).padStart(2, "0")}|bengaluru`)[0])
    )
    expect(leaders.size).toBeGreaterThan(6)
  })
})

describe("featuredOf", () => {
  const SEED = "2026-10-21|bengaluru"

  it("ranks the featured events 1-based in the day's rotation, and never an unfeatured one", () => {
    const events = [ev("late", true), ev("plain", false), ev("early", true), ev("mid", true)]
    const ranks = featuredOf(events, SEED)
    const expected = rotated(events.filter((e) => e.is_featured), SEED).map((e) => e.id)
    expect([...ranks.entries()].sort((a, b) => a[1].rank - b[1].rank).map(([id]) => id)).toEqual(expected)
    expect(ranks.get(expected[0])).toEqual({ kind: "editorial", rank: 1, by: EDITORIAL_BY })
    expect(ranks.has("plain")).toBe(false)
  })

  it("is not start-time order any more: the same events rank differently on another day", () => {
    const events = Array.from({ length: 8 }, (_, i) => ev(`e${i}`, true))
    const rankOn = (seed: string) => [...featuredOf(events, seed)].map(([id, f]) => `${id}:${f.rank}`).sort()
    expect(rankOn("2026-10-21|bengaluru")).not.toEqual(rankOn("2026-10-22|bengaluru"))
  })

  it("returns nothing for a page with no featured event", () => {
    expect(featuredOf([ev("x", false)], SEED).size).toBe(0)
  })
})

describe("featured=true on the query", () => {
  const parse = (q: Record<string, string>) => eventQuerySchema.parse(q)

  it("reads the string the query carries, and defaults to off", () => {
    expect(parse({ featured: "true" }).featured).toBe(true)
    expect(parse({ featured: "false" }).featured).toBe(false)
    expect(parse({}).featured).toBe(false)
  })

  it("rejects what is not a boolean rather than reading it as off", () => {
    expect(eventQuerySchema.safeParse({ featured: "yes" }).success).toBe(false)
  })

  it("is capped at five in the one constant the route reads", () => {
    expect(FEATURED_MAX).toBe(5)
  })

  it("is part of the cache key: the featured five are not the page they were cut from", () => {
    const base = { page: 1, limit: 5, viewerAge: null, sortBy: "start_time", sortOrder: "asc" }
    expect(buildEventsCacheKey({ ...base, featured: true })).not.toBe(buildEventsCacheKey({ ...base, featured: false }))
    expect(buildEventsCacheKey(base)).toBe(buildEventsCacheKey({ ...base, featured: false }))
  })

  it("turns over with the day's rotation for a featured page, and ignores the seed for any other", () => {
    const base = { page: 1, limit: 5, viewerAge: null, sortBy: "start_time", sortOrder: "asc", featured: true }
    expect(buildEventsCacheKey({ ...base, featuredSeed: "2026-10-21|bengaluru" })).not.toBe(
      buildEventsCacheKey({ ...base, featuredSeed: "2026-10-22|bengaluru" })
    )
    const plain = { ...base, featured: false }
    expect(buildEventsCacheKey({ ...plain, featuredSeed: "a" })).toBe(buildEventsCacheKey({ ...plain, featuredSeed: "b" }))
  })
})
