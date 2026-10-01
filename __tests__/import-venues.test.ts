jest.mock("@/lib/db", () => ({ db: {}, closeDb: jest.fn() }))

import {
  columnsOf,
  coordinatesFromMapsUrl,
  duplicateInFile,
  readRow,
  venueTypeFrom,
  type VenueRow,
} from "../scripts/import-venues"
import { fenceFromOsm, type OsmHit } from "../scripts/enrich-venues-from-osm"

/**
 * Founder seeding (step 1): the parts of `scripts/import-venues.ts` that decide
 * what a row means. The database half — the 100 m check against listed venues,
 * the write — goes through `nearbyVenues` and was driven on a migrated local
 * database (see the PR); these pin the parse, where a wrong answer is a venue
 * pinned in the wrong place with nothing to say so.
 */

describe("coordinatesFromMapsUrl", () => {
  it("takes the place's own pin over where the map was centred", () => {
    // `@` is the viewport when the link was copied; `!3d…!4d` is the place.
    const url =
      "https://www.google.com/maps/place/Toit/@12.9700,77.6400,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d12.979123!4d77.640712"
    expect(coordinatesFromMapsUrl(url)).toEqual({ lat: 12.979123, lng: 77.640712 })
  })

  it("reads a typed pair from q, query or ll, and falls back to the map centre", () => {
    expect(coordinatesFromMapsUrl("https://maps.google.com/?q=12.97,77.64")).toEqual({ lat: 12.97, lng: 77.64 })
    expect(coordinatesFromMapsUrl("https://www.google.com/maps/search/?api=1&query=12.9,%2077.6")).toEqual({ lat: 12.9, lng: 77.6 })
    expect(coordinatesFromMapsUrl("https://www.google.co.in/maps/@12.95,77.61,15z")).toEqual({ lat: 12.95, lng: 77.61 })
  })

  it("refuses a search by name, a non-Google host and an impossible coordinate", () => {
    expect(coordinatesFromMapsUrl("https://www.google.com/maps/search/toit+indiranagar")).toBeNull()
    expect(coordinatesFromMapsUrl("https://evil.example/maps/@12.97,77.64,17z")).toBeNull()
    expect(coordinatesFromMapsUrl("https://maps.google.com/?q=120.0,77.6")).toBeNull()
    expect(coordinatesFromMapsUrl("not a url")).toBeNull()
  })
})

describe("venueTypeFrom", () => {
  it("takes a value or a label in any case; blank is unclassified; unknown is undefined", () => {
    expect(venueTypeFrom("pub_bar")).toBe("pub_bar")
    expect(venueTypeFrom("Pub or Bar")).toBe("pub_bar")
    expect(venueTypeFrom("  ")).toBeNull()
    expect(venueTypeFrom("dungeon")).toBeUndefined()
  })
})

describe("readRow", () => {
  const base = { name: "Toit Brewpub", city: "Bengaluru", type: "brewery", lat: "12.9792", lng: "77.6407" }
  const offline = () => Promise.reject(new Error("no network in a unit test"))

  it("accepts a complete row", async () => {
    await expect(readRow(base, 2, offline)).resolves.toEqual({
      ok: true,
      row: { line: 2, name: "Toit Brewpub", address: null, city: "Bengaluru", venueType: "brewery", lat: 12.9792, lng: 77.6407 },
    })
  })

  it.each([
    [{ name: "T" }, "no name"],
    [{ city: " " }, "no city"],
    [{ type: "dungeon" }, 'unknown type "dungeon"'],
    [{ lat: "", lng: "" }, "no valid lat/lng or maps link"],
    [{ lat: "91", lng: "77" }, "no valid lat/lng or maps link"],
  ])("refuses %j: %s", async (patch, reason) => {
    await expect(readRow({ ...base, ...patch }, 3, offline)).resolves.toEqual({ ok: false, line: 3, reason })
  })

  it("follows a share link to its coordinates, and refuses one that leads nowhere", async () => {
    const row = { ...base, lat: "", lng: "", maps_url: "https://maps.app.goo.gl/abc123" }
    const resolved = await readRow(row, 4, async () => "https://www.google.com/maps/place/Toit/data=!3d12.979!4d77.6407")
    expect(resolved).toMatchObject({ ok: true, row: { lat: 12.979, lng: 77.6407 } })

    const nowhere = await readRow(row, 5, async () => "https://www.google.com/maps/search/toit")
    expect(nowhere).toEqual({ ok: false, line: 5, reason: "no coordinates in the maps link — paste lat and lng" })
  })
})

describe("duplicateInFile", () => {
  const row = (line: number, lat: number, lng: number): VenueRow =>
    ({ line, name: `r${line}`, address: null, city: "Bengaluru", venueType: null, lat, lng })

  it("catches a second row within 100 m of an earlier one, and lets one 150 m away through", () => {
    const first = row(2, 12.9792, 77.6407)
    expect(duplicateInFile(row(3, 12.9795, 77.6408), [first])).toMatchObject({ of: first, metres: 35 })
    expect(duplicateInFile(row(4, 12.97785, 77.6407), [first])).toBeNull()
  })
})

describe("columnsOf", () => {
  it("maps headers case-insensitively and refuses a file with no name column", () => {
    expect([...columnsOf(["Name", " CITY ", "extra"]).entries()]).toEqual([[0, "name"], [1, "city"]])
    expect(() => columnsOf(["city", "lat"])).toThrow(/no "name" column/)
  })
})

describe("fenceFromOsm — whose footprint a seeded venue gets", () => {
  const square: [number, number][] = [
    [12.9790, 77.6405], [12.9790, 77.6409], [12.9794, 77.6409], [12.9794, 77.6405], [12.9790, 77.6405],
  ]
  const hit = (nameMatched: boolean): OsmHit => ({ tags: { name: "Toit" }, ring: square, distance: 5, nameMatched })

  it("takes a named building's outline, closed ring trimmed", () => {
    expect(fenceFromOsm(hit(true))).toEqual({ type: "polygon", ring: square.slice(0, -1), buffer: 25 })
  })

  it("never takes an unnamed neighbour's, or nothing", () => {
    // An unnamed building near a pin is a different business sharing a postcode.
    expect(fenceFromOsm(hit(false))).toBeNull()
    expect(fenceFromOsm(null)).toBeNull()
  })
})
