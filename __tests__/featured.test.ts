import { EDITORIAL_BY, FEATURED_MAX, featuredKind, featuredOf } from "@/lib/featured"
import { buildEventsCacheKey } from "@/lib/events-cache-key"
import { eventQuerySchema } from "@/lib/validations/event"

/**
 * C1 (home panes): `featured: { kind, rank, by } | null` on the events list.
 * Today the only source is the admin-set `is_featured`; the shape is what a paid
 * `promoted` kind will fit without a client change.
 */
const at = (iso: string) => new Date(iso)
const ev = (id: string, start: string, is_featured: boolean) => ({ id, start_time: at(start), is_featured })

describe("featuredKind", () => {
  it("is editorial for an admin pick and null for everything else", () => {
    expect(featuredKind({ is_featured: true })).toBe("editorial")
    expect(featuredKind({ is_featured: false })).toBeNull()
  })
})

describe("featuredOf", () => {
  it("ranks the featured events by start time, 1-based, and never an unfeatured one", () => {
    const ranks = featuredOf([
      ev("late", "2026-10-21T20:00:00Z", true),
      ev("plain", "2026-10-21T17:00:00Z", false),
      ev("early", "2026-10-21T18:00:00Z", true),
    ])
    expect(ranks.get("early")).toEqual({ kind: "editorial", rank: 1, by: EDITORIAL_BY })
    expect(ranks.get("late")).toEqual({ kind: "editorial", rank: 2, by: "blendn" })
    expect(ranks.has("plain")).toBe(false)
  })

  it("breaks a tie on start time by id, so two requests rank them alike", () => {
    const a = featuredOf([ev("b", "2026-10-21T18:00:00Z", true), ev("a", "2026-10-21T18:00:00Z", true)])
    expect(a.get("a")?.rank).toBe(1)
    expect(a.get("b")?.rank).toBe(2)
  })

  it("returns nothing for a page with no featured event", () => {
    expect(featuredOf([ev("x", "2026-10-21T18:00:00Z", false)]).size).toBe(0)
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
})
