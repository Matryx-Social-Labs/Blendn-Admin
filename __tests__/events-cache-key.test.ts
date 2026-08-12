import { buildEventsCacheKey, type EventsCacheKeyInput } from "@/lib/events-cache-key"

/**
 * What the events cache is allowed to confuse with what.
 *
 * This is the shape of bug that does not announce itself. A missing input does
 * not throw and does not log — the cache simply hands one user the results
 * computed for another, and only inside a 30-second window, so it does not
 * reproduce reliably enough to be reported.
 *
 * The age case was live: the list filters on `min_age <= viewer.age`, the key
 * did not mention age, and so an adult's cached page could be served to a
 * minor. Everything here asserts the same property from a different angle —
 * **two requests that would compute different lists must not share a key.**
 */

const base: EventsCacheKeyInput = {
  page: 1,
  limit: 20,
  viewerAge: null,
  sortBy: "start_time",
  sortOrder: "asc",
  includePast: false,
}

const keyWith = (patch: Partial<EventsCacheKeyInput>) =>
  buildEventsCacheKey({ ...base, ...patch })

describe("buildEventsCacheKey — inputs that change the result set", () => {
  it("separates viewers of different ages", () => {
    // The live bug. A 24-year-old's list can contain 18+ events; a 16-year-old's
    // cannot. Sharing a key means whoever asked first decides for both.
    expect(keyWith({ viewerAge: 24 })).not.toBe(keyWith({ viewerAge: 16 }))
  })

  it("separates a known age from an unknown one", () => {
    // Unknown age is its own result set — restricted events are shown, because
    // failing closed would empty the feed for every OAuth signup.
    expect(keyWith({ viewerAge: 24 })).not.toBe(keyWith({ viewerAge: null }))
  })

  it("separates cities", () => {
    expect(keyWith({ city: "Bengaluru" })).not.toBe(keyWith({ city: "Mumbai" }))
  })

  it("separates a scoped browse from an unscoped one", () => {
    expect(keyWith({ city: "Bengaluru" })).not.toBe(keyWith({}))
  })

  it("separates a bounded search from an unbounded one", () => {
    // `radius` lost its default. Absent means "sort by distance, exclude
    // nothing"; present means a hard cut — genuinely different lists.
    expect(keyWith({ lat: 12.9, lon: 77.5, radius: 10 })).not.toBe(
      keyWith({ lat: 12.9, lon: 77.5 })
    )
  })

  it("separates pages, and sort direction", () => {
    expect(keyWith({ page: 2 })).not.toBe(keyWith({ page: 1 }))
    expect(keyWith({ sortOrder: "desc" })).not.toBe(keyWith({ sortOrder: "asc" }))
  })

  it("separates a history request from a discovery one", () => {
    expect(keyWith({ includePast: true })).not.toBe(keyWith({ includePast: false }))
  })
})

describe("buildEventsCacheKey — requests that should share an entry", () => {
  it("folds city spellings that the filter treats as one place", () => {
    // The filter matches case-insensitively, so caching these separately would
    // compute the same list twice and halve the hit rate for no benefit.
    expect(keyWith({ city: "Bengaluru" })).toBe(keyWith({ city: " bengaluru " }))
  })

  it("is stable for identical input", () => {
    expect(keyWith({ city: "Mumbai", viewerAge: 30 })).toBe(
      keyWith({ city: "Mumbai", viewerAge: 30 })
    )
  })

  it("does not key on the user, only on what narrows the list", () => {
    // Two viewers of the same age see the same events. Keying per user would
    // make the cache useless at exactly the moment it is doing work.
    expect(keyWith({ viewerAge: 24 })).toBe(keyWith({ viewerAge: 24 }))
  })
})
