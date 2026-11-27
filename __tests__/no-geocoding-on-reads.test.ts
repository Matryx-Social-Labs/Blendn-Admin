import { readdirSync, readFileSync } from "fs"
import { join, relative } from "path"
import * as locationModule from "@/lib/location"
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

  it("is null when the lookup fails, never the coordinates", async () => {
    fetchMock.mockRejectedValue(new Error("timeout"))
    await expect(resolveEventCity(null, 12.97, 77.59)).resolves.toBeNull()
    await expect(resolveEventCity(COORDS, null, null)).resolves.toBeNull()
  })

  it("falls back to the pin when coordinates typed as the city name nothing", async () => {
    fetchMock.mockRejectedValueOnce(new Error("timeout"))
    nominatimSays("Bengaluru")
    await expect(resolveEventCity(COORDS, 12.97, 77.59)).resolves.toBe("Bengaluru")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

/*
 * Every caller of the geocoders, found by walking app/ and lib/ rather than by
 * a list somebody has to remember to extend: exactly the writers below name
 * one, and a file holding a read and a write keeps it out of the read's body.
 */
const GEOCODERS = /\b(locationToStore|resolveEventCity|reverseGeocodeCity)\b/

const WRITERS = [
  "app/api/events/[id]/route.ts", // PATCH, when the pin moves (its GET is checked below)
  "app/api/events/route.ts", // POST (its GET is checked below)
  "app/api/mobile/profiles/[userId]/route.ts", // PUT (its GET is checked below)
  "app/dashboard/users/actions.ts", // updateUser (getUsers is checked below)
]

const sourceFiles = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []
  )

const bodyOf = (src: string, start: RegExp, end: RegExp) => {
  const from = src.search(start)
  expect(from).toBeGreaterThanOrEqual(0)
  const rest = src.slice(from)
  const to = rest.slice(1).search(end)
  return to < 0 ? rest : rest.slice(0, to + 1)
}

describe("no read reaches a geocoder", () => {
  it("only the writers name one", () => {
    const naming = [...sourceFiles("app"), ...sourceFiles("lib")]
      .map((f) => relative(ROOT, join(ROOT, f)))
      .filter((f) => f !== "lib/location.ts" && GEOCODERS.test(code(f)))
      .sort()
    expect(naming).toEqual([...WRITERS].sort())
  })

  it("lib/location exports no geocoder the guard does not know", () => {
    expect(Object.keys(locationModule).sort()).toEqual(
      ["locationToStore", "parseCoordinateLocation", "resolveEventCity", "reverseGeocodeCity", "storedCity"].sort()
    )
  })

  it.each([
    ["app/api/mobile/profiles/[userId]/route.ts", /export async function GET\(/, /await locationToStore\(location\)/, /export async function PUT\(/],
    ["app/dashboard/users/actions.ts", /export async function getUsers\(/, /locationToStore\(/, /export async function updateUser\(/],
    ["app/api/events/route.ts", /export async function GET\(/, /resolveEventCity\(city, latitude, longitude\)/, /export async function POST\(/],
    ["app/api/events/[id]/route.ts", /export async function GET\(/, /resolveEventCity\(city, latitude, longitude\)/, /export async function PATCH\(/],
  ])("%s: the read does not, the write does", (file, read, writeCall, write) => {
    const src = code(file)
    expect(bodyOf(src, read, /export async function /)).not.toMatch(GEOCODERS)
    expect(bodyOf(src, write, /export async function /)).toMatch(writeCall)
  })
})
