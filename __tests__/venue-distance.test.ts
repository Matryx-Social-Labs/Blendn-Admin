/*
 * lib/venue-distance.ts: which venues a "nearest first" list ranks once a city
 * has more of them than the candidate ceiling.
 */
const venues: { id: string; name: string; latitude: number | null; longitude: number | null }[] = []
const findMany = jest.fn()
const count = jest.fn()

type Box = { latitude: { gte: number; lte: number }; longitude: { gte: number; lte: number } }
const boxOf = (where: { AND?: unknown[] }): Box | null => (where.AND ? (where.AND[1] as Box) : null)
const inBox = (v: (typeof venues)[number], b: Box | null) =>
  !b ||
  (v.latitude !== null &&
    v.longitude !== null &&
    v.latitude >= b.latitude.gte &&
    v.latitude <= b.latitude.lte &&
    v.longitude >= b.longitude.gte &&
    v.longitude <= b.longitude.lte)

jest.mock("@/lib/db", () => ({
  db: {
    venues: {
      findMany: (args: { where: { AND?: unknown[] }; take: number }) => findMany(args),
      count: (args: { where: { AND?: unknown[] } }) => count(args),
    },
  },
}))

import { distanceCandidates } from "@/lib/venue-distance"
import { haversineDistance } from "@/lib/geo"

const LAT = 12.97
const LON = 77.59
const CEILING = 5

beforeEach(() => {
  venues.length = 0
  findMany.mockReset().mockImplementation(async ({ where, take }) =>
    venues
      .filter((v) => inBox(v, boxOf(where)))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, take)
  )
  count.mockReset().mockImplementation(async ({ where }) => venues.filter((v) => inBox(v, boxOf(where))).length)
})

const add = (name: string, dLat: number, dLon: number) =>
  venues.push({ id: name, name, latitude: LAT + dLat, longitude: LON + dLon })

describe("distanceCandidates", () => {
  it("ranks everything, untouched, while the city fits under the ceiling", async () => {
    for (let i = 0; i < CEILING - 1; i++) add(`v${i}`, i * 0.1, 0)
    const out = await distanceCandidates({}, LAT, LON, true, CEILING)
    expect(out.rows).toHaveLength(CEILING - 1)
    expect(out.truncated).toBe(false)
  })

  it("past the ceiling, keeps the nearest even when their names sort last, and says it truncated", async () => {
    for (let i = 0; i < 12; i++) add(`a${String(i).padStart(2, "0")}`, 0.5 + i * 0.05, 0)
    add("zzz next door", 0.001, 0)
    const out = await distanceCandidates({}, LAT, LON, true, CEILING)
    expect(out.rows.map((r) => r.id)).toContain("zzz next door")
    expect(out.truncated).toBe(true)
  })

  it("probes the ladder with counts and reads the box once, at the first step that fits", async () => {
    for (let i = 0; i < 12; i++) add(`a${String(i).padStart(2, "0")}`, 0.5 + i * 0.05, 0)
    add("zzz next door", 0.001, 0)
    await distanceCandidates({}, LAT, LON, true, CEILING)
    // 200 km and 100 km hold five or more; 50 km holds one. Two row reads in all: the first look, and the box.
    expect(count).toHaveBeenCalledTimes(3)
    expect(findMany).toHaveBeenCalledTimes(2)
  })

  it("when even the narrowest box is over the ceiling, reads it once and still ranks only its circle", async () => {
    for (let i = 0; i < 9; i++) add(`near${i}`, 0.0001 * i, 0)
    const out = await distanceCandidates({}, LAT, LON, true, CEILING)
    expect(findMany).toHaveBeenCalledTimes(2)
    expect(out.rows.length).toBeLessThanOrEqual(CEILING)
    expect(out.truncated).toBe(true)
  })

  it("keeps only rows inside the box's inscribed circle: a corner is up to 1.41x the half-width away", async () => {
    // Five venues 67-71 km out fill the 100 km box, so the ladder lands on 50 km. The corner (~69 km away)
    // is inside that box but farther than a venue just beyond its edge would be, so it must not be ranked.
    for (let i = 0; i < 5; i++) add(`mid${i}`, 0.6 + i * 0.02, 0)
    add("corner", 0.44, 0.44 / Math.cos((LAT * Math.PI) / 180))
    add("inside", 0.1, 0)
    const out = await distanceCandidates({}, LAT, LON, true, CEILING)
    expect(out.rows.map((r) => r.id)).toEqual(["inside"])
    for (const r of out.rows) {
      expect(haversineDistance(LAT, LON, r.latitude!, r.longitude!)).toBeLessThanOrEqual(50)
    }
    expect(out.truncated).toBe(true)
  })

  it("keeps the name-ordered fetch for farthest-first", async () => {
    for (let i = 0; i < 8; i++) add(`v${i}`, i * 0.1, 0)
    const out = await distanceCandidates({}, LAT, LON, false, CEILING)
    expect(out.rows).toHaveLength(CEILING)
    expect(out.truncated).toBe(true)
  })
})
