const markets = jest.fn()
const cities = jest.fn()
const previewers = jest.fn()
const logError = jest.fn()

jest.mock("@/lib/db", () => ({
  db: {
    markets: { findMany: (...a: unknown[]) => markets(...a) },
    cities: { findMany: (...a: unknown[]) => cities(...a) },
    market_previewers: { findMany: (...a: unknown[]) => previewers(...a) },
  },
}))
jest.mock("@/lib/logger", () => ({ logger: { error: (...a: unknown[]) => logError(...a) } }))

import { buildCatalogue, cityCatalogue, previewMarketsFor } from "@/lib/cities"
import { clearCityCatalogue } from "./support/city-catalogue"

const MARKET = { code: "AA", name: "Aland", launch_state: "preview" as const, sort: 0 }
const CITY = {
  id: "c1",
  market_code: "AA",
  slug: "alpha",
  name: "Alpha",
  match_names: ["alpha"],
  timezone: "UTC",
  launch_state: "preview" as const,
  is_default: true,
  centre_lat: 1,
  centre_lon: 1,
  min_lat: 0,
  min_lon: 0,
  max_lat: 2,
  max_lon: 2,
  sort: 0,
}

beforeEach(() => {
  jest.clearAllMocks()
  clearCityCatalogue()
  markets.mockResolvedValue([MARKET])
  cities.mockResolvedValue([CITY])
  previewers.mockResolvedValue([{ market_code: "AA" }])
})
afterEach(() => jest.useRealTimers())

describe("cityCatalogue", () => {
  it("reads once within 60 s, for concurrent callers too, and again after", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] })
    await Promise.all([cityCatalogue(), cityCatalogue()])
    jest.advanceTimersByTime(59_000)
    await cityCatalogue()
    expect(cities).toHaveBeenCalledTimes(1)
    jest.advanceTimersByTime(2_000)
    await cityCatalogue()
    expect(cities).toHaveBeenCalledTimes(2)
  })

  it("does not cache a failed read", async () => {
    cities.mockRejectedValueOnce(new Error("down"))
    await expect(cityCatalogue()).rejects.toThrow("down")
    expect((await cityCatalogue()).cities).toHaveLength(1)
  })
})

describe("previewMarketsFor", () => {
  const preview = buildCatalogue([MARKET], [CITY])

  it("reads nothing while nothing is in preview", async () => {
    const live = buildCatalogue([{ ...MARKET, launch_state: "live" }], [{ ...CITY, launch_state: "live" }])
    expect((await previewMarketsFor("u1", live)).size).toBe(0)
    expect(previewers).not.toHaveBeenCalled()
  })

  it("reads once per person per minute, and one person's answer is not another's", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] })
    expect(await previewMarketsFor("u1", preview)).toEqual(new Set(["AA"]))
    await previewMarketsFor("u1", preview)
    expect(previewers).toHaveBeenCalledTimes(1)

    previewers.mockResolvedValueOnce([])
    expect((await previewMarketsFor("u2", preview)).size).toBe(0)
    expect(previewers).toHaveBeenCalledTimes(2)

    jest.advanceTimersByTime(61_000)
    await previewMarketsFor("u1", preview)
    expect(previewers).toHaveBeenCalledTimes(3)
  })

  it("does not cache a failed read: a blip must not read as not a previewer", async () => {
    previewers.mockRejectedValueOnce(new Error("down"))
    await expect(previewMarketsFor("u1", preview)).rejects.toThrow("down")
    expect(await previewMarketsFor("u1", preview)).toEqual(new Set(["AA"]))
  })
})

describe("two cities claiming one name", () => {
  it("keeps the earlier city and says so", () => {
    const twin = { ...CITY, id: "c2", slug: "twin", name: "Twin", match_names: ["alpha"], sort: 1 }
    const catalogue = buildCatalogue([MARKET], [twin, CITY])
    expect(catalogue.cityByKey.get("alpha")?.slug).toBe("alpha")
    expect(logError).toHaveBeenCalledWith("Two cities claim one name", { key: "alpha", kept: "alpha", ignored: "twin" })
  })
})
