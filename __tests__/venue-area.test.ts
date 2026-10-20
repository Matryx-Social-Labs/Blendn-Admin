jest.mock("@/lib/db", () => ({ db: {}, closeDb: jest.fn() }))

import { readAreas } from "../scripts/backfill-venue-areas"
import { areaSlug } from "@/lib/venue-area"

/**
 * C4 (home panes): `venues.area` / `area_slug`. The slug is the one spelling the
 * `area=` filter, the summary and the backfill share; the backfill file is read
 * strictly, because a wrong row labels a real venue with the wrong place.
 */
describe("areaSlug", () => {
  it.each([
    ["Indiranagar", "indiranagar"],
    ["Koramangala 1st Block", "koramangala-1st-block"],
    ["J.P Nagar", "j-p-nagar"],
    ["  HSR Layout, ", "hsr-layout"],
    ["Bangalore, Karnātaka", "bangalore-karnataka"],
  ])("%s -> %s", (name, slug) => {
    expect(areaSlug(name)).toBe(slug)
  })

  it("is null for a name with nothing to slug, never an empty string", () => {
    expect(areaSlug("  --  ")).toBeNull()
    expect(areaSlug("")).toBeNull()
  })
})

describe("readAreas", () => {
  const A = "11111111-1111-4111-8111-111111111111"
  const B = "22222222-2222-4222-8222-222222222222"
  const C = "33333333-3333-4333-8333-333333333333"

  it("groups the rows by area, the biggest first", () => {
    const groups = readAreas(`id,area\n${A},Indiranagar\n${B},HSR Layout\n${C},HSR Layout\n`)
    expect(groups.map((g) => [g.area, g.slug, g.ids.length])).toEqual([
      ["HSR Layout", "hsr-layout", 2],
      ["Indiranagar", "indiranagar", 1],
    ])
  })

  it("makes two spellings of one slug one area, under the first spelling", () => {
    const groups = readAreas(`id,area\n${A},Café Road\n${B},Cafe Road\n`)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ area: "Café Road", slug: "cafe-road" })
  })

  it("refuses a row it cannot trust, naming the line", () => {
    expect(() => readAreas(`id,area\nnot-an-id,Indiranagar\n`)).toThrow(/line 2/)
    expect(() => readAreas(`id,area\n${A},Indiranagar\n${A},HSR Layout\n`)).toThrow(/line 3.*twice/)
    expect(() => readAreas(`id,area\n${A},--\n`)).toThrow(/line 2/)
    expect(() => readAreas(`id,place\n${A},x\n`)).toThrow(/id and an area/)
  })
})
