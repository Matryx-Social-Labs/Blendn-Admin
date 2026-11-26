import { readFileSync } from "fs"
import { join } from "path"
import { locationToStore, resolveEventCity, storedCity } from "@/lib/location"

/**
 * A read never calls Nominatim (SCRUM-1229).
 *
 * Sign-in, session, a profile, a friend, favourites, event detail, the feed and
 * the check-ins list each reverse-geocoded a coordinate-shaped `location` or
 * `city`: up to 3.5 s on a user read, a burst past Nominatim's 1 req/s policy,
 * and every failure cached as null for the life of the process. A read now
 * returns the stored text, or null while it is still coordinates (never the
 * coordinates themselves: a profile other people fetch must not carry where
 * somebody was standing). Only a write geocodes.
 */

const ROOT = join(__dirname, "..")
const code = (rel: string) =>
  readFileSync(join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")

const COORDS = "12.97,77.59"
const fetchMock = jest.fn()
const nominatimSays = (city: string) =>
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ address: { city } }) })

beforeEach(() => {
  fetchMock.mockReset()
  global.fetch = fetchMock as unknown as typeof fetch
})

describe("storedCity: what a read returns", () => {
  it("is the stored text, trimmed", () => {
    expect(storedCity("  Bengaluru ")).toBe("Bengaluru")
    expect(storedCity("Toronto")).toBe("Toronto")
  })

  it("is null for coordinates, never the coordinates", () => {
    expect(storedCity(COORDS)).toBeNull()
    expect(storedCity(" 43.6532, -79.3832 ")).toBeNull()
  })

  it("is null for nothing", () => {
    expect(storedCity(null)).toBeNull()
    expect(storedCity(undefined)).toBeNull()
    expect(storedCity("   ")).toBeNull()
  })

  it("makes no request", () => {
    storedCity(COORDS)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("locationToStore: what a write stores", () => {
  it("geocodes coordinates once and stores the city", async () => {
    nominatimSays("Bengaluru")
    await expect(locationToStore(COORDS)).resolves.toBe("Bengaluru")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/^https:\/\/nominatim\.openstreetmap\.org\/reverse\?/)
  })

  it("leaves the column alone when the geocode fails, rather than writing null over a city", async () => {
    fetchMock.mockRejectedValueOnce(new Error("timeout"))
    await expect(locationToStore(COORDS)).resolves.toBeUndefined()
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 })
    await expect(locationToStore(COORDS)).resolves.toBeUndefined()
  })

  it("never remembers a failure: the next write asks again", async () => {
    fetchMock.mockRejectedValueOnce(new Error("timeout"))
    await locationToStore(COORDS)
    nominatimSays("Bengaluru")
    await expect(locationToStore(COORDS)).resolves.toBe("Bengaluru")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("stores text as typed, clears on null or empty, and does nothing when nothing was sent", async () => {
    await expect(locationToStore(" Toronto ")).resolves.toBe("Toronto")
    await expect(locationToStore(null)).resolves.toBeNull()
    await expect(locationToStore("  ")).resolves.toBeNull()
    await expect(locationToStore(undefined)).resolves.toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe("resolveEventCity: an event write", () => {
  it("geocodes the pin when no city was typed", async () => {
    nominatimSays("Bengaluru")
    await expect(resolveEventCity(null, 12.97, 77.59)).resolves.toBe("Bengaluru")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("keeps a typed city without asking anybody", async () => {
    await expect(resolveEventCity("Toronto", 43.65, -79.38)).resolves.toBe("Toronto")
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

/*
 * Every caller of the geocoders, read or write. A read-only file imports
 * nothing from lib/location that can make a request; a file holding both a
 * read and a write keeps the geocoder out of the read's body.
 */
const GEOCODERS = /\b(locationToStore|resolveEventCity|reverseGeocodeCity|normalizeLocationToCity)\b/

const READ_ONLY = [
  "app/api/mobile/auth/signin/route.ts",
  "app/api/mobile/auth/session/route.ts",
  "app/api/mobile/auth/apple/route.ts",
  "app/api/mobile/auth/google/route.ts",
  "app/api/mobile/auth/signup/route.ts",
  "app/api/mobile/friends/[userId]/route.ts",
  "app/api/mobile/users/[userId]/favorites/route.ts",
  "app/api/mobile/events/route.ts",
  "app/api/mobile/events/[eventId]/route.ts",
  "app/api/mobile/events/[eventId]/checkins/route.ts",
  "lib/public-profile.ts",
  "lib/self-profile.ts",
  "lib/services/events.service.ts",
]

const bodyOf = (src: string, start: RegExp, end: RegExp) => {
  const from = src.search(start)
  expect(from).toBeGreaterThanOrEqual(0)
  const rest = src.slice(from)
  const to = rest.slice(1).search(end)
  return to < 0 ? rest : rest.slice(0, to + 1)
}

describe("no read reaches a geocoder", () => {
  it.each(READ_ONLY)("%s", (file) => {
    expect(code(file)).not.toMatch(GEOCODERS)
  })

  it("profiles/[userId]: the GET does not, the PUT does", () => {
    const src = code("app/api/mobile/profiles/[userId]/route.ts")
    expect(bodyOf(src, /export async function GET\(/, /export async function /)).not.toMatch(GEOCODERS)
    expect(bodyOf(src, /export async function PUT\(/, /export async function /)).toMatch(/await locationToStore\(location\)/)
  })

  it("dashboard users: the list does not, the edit does", () => {
    const src = code("app/dashboard/users/actions.ts")
    expect(bodyOf(src, /export async function getUsers\(/, /export async function /)).not.toMatch(GEOCODERS)
    expect(bodyOf(src, /export async function updateUser\(/, /export async function /)).toMatch(/locationToStore\(/)
  })
})
