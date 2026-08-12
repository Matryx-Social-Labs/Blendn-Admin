import { cityFrom, cityKey, extractAddress, groupCities } from "@/lib/address"

/**
 * Reading a geocoder response.
 *
 * The bug this closes is not a crash — it is two screens quietly disagreeing
 * about what to call the same place, so the city picker splits one city's
 * events across two entries and each half looks correct in isolation.
 *
 * The Whitefield case is the one worth keeping: it is why `city` is checked
 * before anything else, and it is the case that a "use the most specific name"
 * instinct gets wrong.
 */

describe("cityFrom — settlement before region", () => {
  it("prefers the city over a suburb inside it", () => {
    // Whitefield is in BBMP limits, so Nominatim returns both. Taking the more
    // specific name would file these events under a neighbourhood and split
    // Bengaluru across a dozen of them.
    expect(cityFrom({ suburb: "Whitefield", city: "Bengaluru", state: "Karnataka" }))
      .toBe("Bengaluru")
  })

  it("uses the town when there is no city — a separate town is not a suburb", () => {
    expect(cityFrom({ town: "Anekal", state_district: "Bangalore Rural" })).toBe("Anekal")
  })

  it("uses the village rather than falling through to the district", () => {
    // The old venue form skipped village entirely and returned the district,
    // so the same pin was "Bangalore Rural" there and the village name in the
    // event form.
    expect(cityFrom({ village: "Hesaraghatta", state_district: "Bangalore Rural" }))
      .toBe("Hesaraghatta")
  })

  it("reaches a region only when no settlement was named", () => {
    expect(cityFrom({ state_district: "Bangalore Rural", state: "Karnataka" }))
      .toBe("Bangalore Rural")
  })

  it("is null when the address names nothing usable", () => {
    expect(cityFrom({ country: "India" })).toBeNull()
    expect(cityFrom({})).toBeNull()
    expect(cityFrom(undefined)).toBeNull()
  })

  it("ignores whitespace-only values instead of returning them", () => {
    expect(cityFrom({ city: "   ", town: "Anekal" })).toBe("Anekal")
  })
})

describe("extractAddress", () => {
  it("pulls all four fields out of one response", () => {
    expect(
      extractAddress(12.9716, 77.5946, {
        display_name: "MG Road, Bengaluru, Karnataka, 560001, India",
        address: {
          road: "MG Road",
          city: "Bengaluru",
          state: "Karnataka",
          postcode: "560001",
          country: "India",
        },
      })
    ).toEqual({
      address: "MG Road, Bengaluru, Karnataka, 560001, India",
      city: "Bengaluru",
      state: "Karnataka",
      country: "India",
      postalCode: "560001",
    })
  })

  it("falls back to coordinates when the geocoder returned nothing", () => {
    const resolved = extractAddress(12.9716, 77.5946, undefined)
    expect(resolved.address).toBe("12.971600, 77.594600")
    expect(resolved.city).toBeNull()
  })

  it("nulls missing parts rather than emptying them to a string", () => {
    // An empty string sorts and groups as a real value; null does not. The old
    // picker wrote "" and those rows then matched nothing and everything
    // depending on the query.
    const resolved = extractAddress(0, 0, { display_name: "Somewhere", address: {} })
    expect(resolved.city).toBeNull()
    expect(resolved.state).toBeNull()
    expect(resolved.postalCode).toBeNull()
  })
})

describe("cityKey", () => {
  it("groups the same city written two ways", () => {
    expect(cityKey("  Bengaluru ")).toBe(cityKey("bengaluru"))
  })

  it("keeps genuinely different names apart", () => {
    // Deliberately not an alias map: merging by guess would collapse the two
    // Springfields as readily as it would join Bangalore to Bengaluru.
    expect(cityKey("Bangalore")).not.toBe(cityKey("Bengaluru"))
  })

  it("maps absent to empty rather than throwing", () => {
    expect(cityKey(null)).toBe("")
    expect(cityKey(undefined)).toBe("")
  })
})

/**
 * The city picker's list.
 *
 * The rule this has to keep is the one a user notices: **a city listed with N
 * events must open with N events.** Everything here is in service of that —
 * fold the spellings that are one place, drop the rows the filter cannot find,
 * and never invent an entry.
 */
describe("groupCities", () => {
  it("folds spellings that differ only by case or padding", () => {
    expect(groupCities(["Bengaluru", "bengaluru", " Bengaluru "])).toEqual([
      { city: "Bengaluru", eventCount: 3 },
    ])
  })

  it("labels with the most common spelling, not the first seen", () => {
    // "First" would rename the whole city in the picker the moment one event
    // was deleted, which reads as data loss to anyone watching.
    expect(groupCities(["bengaluru", "Bengaluru", "Bengaluru"])).toEqual([
      { city: "Bengaluru", eventCount: 3 },
    ])
  })

  it("keeps genuinely different cities apart", () => {
    expect(groupCities(["Bengaluru", "Mumbai", "Bengaluru"])).toEqual([
      { city: "Bengaluru", eventCount: 2 },
      { city: "Mumbai", eventCount: 1 },
    ])
  })

  it("orders busiest first, then alphabetically", () => {
    // The tiebreak is not cosmetic: Postgres returns rows in no defined order,
    // so without it the same screen could list cities differently twice.
    expect(groupCities(["Delhi", "Chennai", "Mumbai", "Mumbai"])).toEqual([
      { city: "Mumbai", eventCount: 2 },
      { city: "Chennai", eventCount: 1 },
      { city: "Delhi", eventCount: 1 },
    ])
  })

  it("drops nulls and blanks rather than listing an unnamed city", () => {
    // These events are also unreachable by the `city` filter, so listing them
    // would promise a city that opens empty — the exact failure this endpoint
    // exists to prevent.
    expect(groupCities([null, "  ", "", "Mumbai"])).toEqual([
      { city: "Mumbai", eventCount: 1 },
    ])
  })

  it("is empty for no events at all", () => {
    expect(groupCities([])).toEqual([])
  })
})
