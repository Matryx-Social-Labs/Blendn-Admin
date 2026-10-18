jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
// A city with more venues than the cap, in miniature: the cap is the constant, so lower it.
jest.mock("@/lib/venue-distance", () => ({
  ...jest.requireActual("@/lib/venue-distance"),
  DISTANCE_SORT_CEILING: 5,
}))

import { closeDb, db } from "./helpers"
import { LAT, LNG, cleanupWorld, person, req, world } from "./go-live-world"

/**
 * "Nearest first" must mean the nearest, however many venues the city has.
 *
 * The distance sort pulled at most DISTANCE_SORT_CEILING candidates ordered by
 * NAME, then sorted them by distance. Past the cap, the venues it dropped were
 * the ones whose names sort late, whether or not they were next door: a city
 * with more places than the cap lost its nearest to the alphabet.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const venuesRoute = require("@/app/api/mobile/venues/route") as typeof import("@/app/api/mobile/venues/route")

const TOKEN = `zvd${Date.now().toString(36).replace(/\d/g, "")}q`
let nearestId: string

beforeAll(async () => {
  // Eleven venues about 55-110 km out, named to sort first; the one next door sorts last.
  for (let i = 0; i < 11; i++) {
    const v = await db.venues.create({
      data: { name: `${TOKEN} a${String(i).padStart(2, "0")}`, city: "Bengaluru", latitude: LAT + 0.5 + i * 0.05, longitude: LNG },
    })
    world.venues.push(v.id)
  }
  const near = await db.venues.create({
    data: { name: `${TOKEN} zzz next door`, city: "Bengaluru", latitude: LAT + 0.001, longitude: LNG },
  })
  nearestId = near.id
  world.venues.push(near.id)
})

afterAll(async () => {
  await cleanupWorld()
  await closeDb()
})

it("lists the nearest venue first although its name sorts after more than the cap", async () => {
  const me = await person()
  const res = await venuesRoute.GET(
    req(`/api/mobile/venues?search=${TOKEN}&lat=${LAT}&lon=${LNG}&sortBy=distance&sortOrder=asc&limit=3`, me.token)
  )
  expect(res.status).toBe(200)
  const venues = (await res.json()).data.venues as { id: string; distance: number }[]
  expect(venues[0].id).toBe(nearestId)
  expect(venues.map((v) => v.distance)).toEqual([...venues.map((v) => v.distance)].sort((a, b) => a - b))
})
