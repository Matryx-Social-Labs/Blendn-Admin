import { cityCentres, cityFrom, cityKey, extractAddress, fillFromSearch, groupCities } from "@/lib/address"

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

/*
 * What a new address search leaves in the venue wizard's address and city
 * (SCRUM-341). The wizard kept any non-empty address, so a second search moved
 * the pin and left the first search's address: two venues on staging were
 * saved kilometres from the place their pin marks.
 */
describe("fillFromSearch", () => {
  const empty = { address: "", city: "" }
  const start = { ...empty, lastFill: empty }
  const churchStreet = { address: "Church Street, Ashok Nagar, Bengaluru", city: "Bengaluru" }
  const cubbonPark = { address: "Cubbon Park, Sampangi Rama Nagara, Bengaluru", city: "Bengaluru" }
  const lisbon = { address: "Praça do Comércio, Lisboa", city: "Lisboa" }

  it("two searches in a row: the second replaces what the first filled in — the bug", () => {
    const afterFirst = fillFromSearch(start, churchStreet)
    expect(afterFirst).toEqual({ ...churchStreet, lastFill: churchStreet })
    expect(fillFromSearch(afterFirst, cubbonPark)).toEqual({ ...cubbonPark, lastFill: cubbonPark })
    expect(fillFromSearch(afterFirst, lisbon)).toMatchObject(lisbon)
  })

  it("keeps an address typed between searches, and still moves the city on", () => {
    const typed = { ...fillFromSearch(start, churchStreet), address: "Unit 4, Brewery Lane" }
    expect(fillFromSearch(typed, lisbon)).toEqual({ address: "Unit 4, Brewery Lane", city: "Lisboa", lastFill: lisbon })
  })

  it("keeps a city typed between searches", () => {
    const typed = { ...fillFromSearch(start, churchStreet), city: "Bangalore" }
    expect(fillFromSearch(typed, cubbonPark)).toMatchObject({ address: cubbonPark.address, city: "Bangalore" })
  })

  it("refills a field the person cleared", () => {
    const cleared = { ...fillFromSearch(start, churchStreet), address: "", city: "" }
    expect(fillFromSearch(cleared, cubbonPark)).toMatchObject(cubbonPark)
  })

  it("keeps an address typed before any search", () => {
    const typedFirst = { address: "Unit 4, Brewery Lane", city: "", lastFill: empty }
    expect(fillFromSearch(typedFirst, churchStreet)).toMatchObject({ address: "Unit 4, Brewery Lane", city: "Bengaluru" })
  })
})

describe("the venue wizard goes through fillFromSearch, and only its newest search writes", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const src = require("fs").readFileSync(require("path").join(__dirname, "../components/venue-create-form.tsx"), "utf8") as string

  it("does not keep a stale address or city on a new search", () => {
    expect(src).toContain("...fillFromSearch(d, found)")
    expect(src).not.toMatch(/address: d\.address \|\|/)
    expect(src).not.toMatch(/city: d\.city \|\|/)
  })

  it("drops a search that a newer one superseded", () => {
    // Two quick searches can resolve out of order; the older must not put its
    // pin and address back (review finding on SCRUM-341). Since SCRUM-354 the
    // wizard searches through VenueArea → WhereSearch, which keeps the guard.
    expect(src).toMatch(/<VenueArea/)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const read = (f: string) => require("fs").readFileSync(require("path").join(__dirname, f), "utf8") as string
    expect(read("../components/venue-area.tsx")).toMatch(/<WhereSearch/)
    const search = read("../components/event-form/where-search.tsx")
    expect(search).toMatch(/const mine = \+\+seq\.current/)
    expect(search).toMatch(/if \(mine !== seq\.current\) return/)
  })
})

describe("cityCentres", () => {
  it("is the mean of a city's event points, folded on cityKey like the counts", () => {
    const centres = cityCentres([
      { city: "Bengaluru", latitude: 12.9, longitude: 77.5 },
      { city: " bengaluru ", latitude: 13.1, longitude: 77.7 },
      { city: "Mumbai", latitude: 19.0, longitude: 72.8 },
    ])
    expect(centres.get(cityKey("Bengaluru")!)).toEqual({ latitude: 13, longitude: 77.6 })
    expect(centres.get(cityKey("Mumbai")!)).toEqual({ latitude: 19, longitude: 72.8 })
  })

  it("leaves out events with no point, or the 0,0 an unset point reads as, and gives a city with none no centre", () => {
    const centres = cityCentres([
      { city: "Pune", latitude: null, longitude: null },
      { city: "Pune", latitude: 0, longitude: 0 },
      { city: "Goa", latitude: 15.5, longitude: 73.8 },
      { city: "Goa", latitude: 0, longitude: 0 },
    ])
    expect(centres.has(cityKey("Pune")!)).toBe(false)
    expect(centres.get(cityKey("Goa")!)).toEqual({ latitude: 15.5, longitude: 73.8 })
  })
})
