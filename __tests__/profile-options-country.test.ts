/*
 * `GET /profile-options` per country (SCRUM-711, SCRUM-1082). Without `?country=`
 * it is exactly what installed builds read today (India's lists), byte for
 * byte. With one: that country's languages, its regions and their word, and its
 * this-or-that; a country without lists of its own, or none, is neutral, never India.
 */
import { readFileSync } from "fs"
import { join } from "path"
import { NextRequest } from "next/server"

jest.mock("@/lib/mobile-auth", () => ({ getAuthenticatedUser: jest.fn(async () => ({ userId: "u1" })) }))

import { GET } from "@/app/api/mobile/profile-options/route"
import { homeStateLabel, isHomeState, isHomeStateIn, isLanguage } from "@/lib/about-you"

type Options = {
  country?: string | null
  regionWord?: string | null
  languages: { slug: string; label: string }[]
  homeStates: { slug: string; label: string }[]
  thisOrThat: { slug: string }[]
}

const INDIA_ONLY = ["coffee_or_chai", "sunrise_or_late_walk", "metro_or_auto", "cup_namdu_or_no_cricket", "bollywood_or_techno"]

async function get(query = ""): Promise<{ text: string; body: Options; cache: string | null }> {
  const res = await GET(new NextRequest(`http://localhost/api/mobile/profile-options${query}`))
  expect(res.status).toBe(200)
  const text = await res.text()
  return { text, body: JSON.parse(text).data as Options, cache: res.headers.get("cache-control") }
}

const legacy = readFileSync(join(__dirname, "fixtures/profile-options-india.json"), "utf8")

describe("GET /profile-options", () => {
  it("with no country is today's response, byte for byte, for installed builds", async () => {
    const { text, cache } = await get()
    expect(text).toBe(legacy)
    expect(cache).toBe("public, max-age=3600, stale-while-revalidate=86400")
  })

  it("India by name is India's lists unchanged, plus its country and the word for its regions", async () => {
    const { body } = await get("?country=IN")
    const { data: today } = JSON.parse(legacy) as { data: Record<string, unknown> }
    expect(body).toEqual({ ...today, country: "IN", regionWord: "state" })
  })

  it("Canada: English and French first, the provinces called provinces, and no India-only question", async () => {
    const { body } = await get("?country=CA")
    expect(body.country).toBe("CA")
    expect(body.regionWord).toBe("province")
    expect(body.languages.slice(0, 2).map((l) => l.slug)).toEqual(["english", "french"])
    expect(body.languages.some((l) => l.slug.endsWith("_learning"))).toBe(false)
    expect(body.homeStates.map((s) => s.label)).toEqual(expect.arrayContaining(["Ontario", "Quebec", "British Columbia", "Grew up abroad"]))
    expect(body.homeStates.some((s) => s.slug === "kerala")).toBe(false)
    expect(body.thisOrThat.filter((q) => INDIA_ONLY.includes(q.slug))).toEqual([])
    expect(body.thisOrThat.map((q) => q.slug)).toContain("hockey_or_no_hockey")
  })

  it("takes the code in either case", async () => {
    expect((await get("?country=ca")).body.country).toBe("CA")
  })

  it.each(["?country=FR", "?country=", "?country=C4", "?country=IND"])("%s is neutral: no regions, every language by name, no country's own questions", async (query) => {
    const { body } = await get(query)
    expect(body.country).toBeNull()
    expect(body.regionWord).toBeNull()
    expect(body.homeStates).toEqual([])
    expect(body.languages.map((l) => l.slug)).toEqual(expect.arrayContaining(["english", "french", "hindi", "kannada"]))
    expect(body.languages.some((l) => l.slug.endsWith("_learning"))).toBe(false)
    const labels = body.languages.map((l) => l.label)
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)))
    expect(body.thisOrThat.length).toBeGreaterThan(0)
    expect(body.thisOrThat.filter((q) => INDIA_ONLY.includes(q.slug) || q.slug === "hockey_or_no_hockey")).toEqual([])
  })
})

describe("regions are per country, labels are everybody's", () => {
  it("a province is a home region in Canada and not in India, a state the other way", () => {
    expect(isHomeStateIn("CA", "ontario")).toBe(true)
    expect(isHomeStateIn("IN", "ontario")).toBe(false)
    expect(isHomeStateIn("IN", "kerala")).toBe(true)
    expect(isHomeStateIn("CA", "kerala")).toBe(false)
    expect(isHomeStateIn("CA", "abroad")).toBe(true)
  })
  it("a stored slug from any country still has its label, so a card never shows a raw slug", () => {
    expect(isHomeState("quebec")).toBe(true)
    expect(homeStateLabel("quebec")).toBe("Quebec")
    expect(homeStateLabel("kerala")).toBe("Kerala")
    expect(isLanguage("french")).toBe(true)
  })
})
