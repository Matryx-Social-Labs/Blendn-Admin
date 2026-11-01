/*
 * /dashboard/markets (travel P5, SCRUM-709): an admin sets who sees which country
 * and city, adds a city or a country as rows, and manages a market's previewers.
 * Against real rows: only an admin writes, a city never goes live empty, every
 * action leaves exactly one audit row, and the app's catalogue cache follows the
 * save at once rather than a minute later.
 */
let actingUser: { id: string; role: "attendee" | "organizer" | "app_admin" } | null = null
// The session alone is replaced: requireAdmin and currentUser run, and the role is read from the user row.
jest.mock("@/lib/auth", () => {
  const session = () => Promise.resolve(actingUser ? { user: { id: actingUser.id, signedInAt: Date.now() } } : null)
  return { getAuth: session, getInviteAuth: session }
})
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import {
  addPreviewer,
  createCity,
  createMarket,
  getMarkets,
  removePreviewer,
  setCityState,
  setMarketState,
} from "@/lib/market-actions"
import { cityCatalogue, previewMarketsFor } from "@/lib/cities"
import { db, closeDb, makeUser, makeEvent, testId } from "./helpers"
import { clearCityCatalogue } from "../support/city-catalogue"

// Two letters no ISO country uses, so the fixtures never meet the seeded IN/CA rows.
const CODE = "XQ"
const NEW_CODE = "XR"
const slugOf = (label: string) => testId(label).toLowerCase().replace(/_/g, "-")

const users: string[] = []
const events: string[] = []
let admin: string
let organiser: string
let attendee: string
let emptySlug: string
let suppliedSlug: string

const cityInput = (slug: string, name = "Testville") => ({
  marketCode: CODE,
  slug,
  name,
  matchNames: name.toLowerCase(),
  region: "TV",
  timezone: "America/Toronto",
  centreLat: 10.5,
  centreLon: 20.5,
  minLat: 10,
  minLon: 20,
  maxLat: 11,
  maxLon: 21,
  licensedMinAge: "19",
})

const auditRows = (resourceId: string) => db.audit_logs.count({ where: { resource_id: resourceId } })
const snapshot = async () => ({
  markets: await db.markets.findMany({ where: { code: { in: [CODE, NEW_CODE] } }, orderBy: { code: "asc" } }),
  cities: await db.cities.findMany({ where: { market_code: CODE }, orderBy: { slug: "asc" } }),
  previewers: await db.market_previewers.count({ where: { market_code: CODE } }),
  audit: await db.audit_logs.count({ where: { resource: { in: ["market", "city"] }, user_id: { in: users } } }),
})

beforeAll(async () => {
  admin = await makeUser("mk_admin", "app_admin")
  organiser = await makeUser("mk_org", "organizer")
  attendee = await makeUser("mk_att")
  users.push(admin, organiser, attendee)
  await db.markets.create({ data: { code: CODE, name: "Testland", currency: "TLD", locale: "en-XQ", launch_state: "live", sort: 90 } })
  emptySlug = slugOf("empty")
  suppliedSlug = slugOf("supplied")
  const base = { market_code: CODE, timezone: "America/Toronto", centre_lat: 10.5, centre_lon: 20.5, min_lat: 10, min_lon: 20, max_lat: 11, max_lon: 21 }
  await db.cities.createMany({
    data: [
      { ...base, slug: emptySlug, name: `Emptyville ${emptySlug}`, launch_state: "preview" },
      { ...base, slug: suppliedSlug, name: `Fullton ${suppliedSlug}`, launch_state: "preview", sort: 1 },
    ],
  })
  // One upcoming listed event in the supplied city.
  const eventId = await makeEvent(organiser)
  events.push(eventId)
  await db.events.update({ where: { id: eventId }, data: { city: `Fullton ${suppliedSlug}` } })
})

afterEach(() => {
  actingUser = null
})

afterAll(async () => {
  await db.audit_logs.deleteMany({ where: { user_id: { in: users } } })
  await db.market_previewers.deleteMany({ where: { market_code: { in: [CODE, NEW_CODE] } } })
  await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
  await db.events.deleteMany({ where: { id: { in: events } } })
  await db.cities.deleteMany({ where: { market_code: { in: [CODE, NEW_CODE] } } })
  await db.markets.deleteMany({ where: { code: { in: [CODE, NEW_CODE] } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  clearCityCatalogue()
  await closeDb()
})

describe("only an admin", () => {
  it.each([
    ["nobody signed in", () => null],
    ["an organiser", () => ({ id: organiser, role: "organizer" as const })],
    ["an attendee", () => ({ id: attendee, role: "attendee" as const })],
  ])("refuses %s on every action and writes nothing", async (_who, as) => {
    const before = await snapshot()
    actingUser = as()
    const attempts = [
      () => getMarkets(),
      () => setMarketState(CODE, "hidden"),
      () => setCityState(suppliedSlug, "live"),
      () => createCity(cityInput(slugOf("nope"))),
      () => createMarket({ code: NEW_CODE, name: "Nowhere", currency: "EUR", locale: "en-XR" }),
      () => addPreviewer(CODE, `${attendee}@itest.invalid`),
      () => removePreviewer(CODE, attendee),
    ]
    for (const attempt of attempts) await expect(attempt()).rejects.toThrow("Forbidden")
    expect(await snapshot()).toEqual(before)
  })
})

describe("a city never goes live empty", () => {
  it("refuses a city with no upcoming listed events and no listed venues, and says why", async () => {
    actingUser = { id: admin, role: "app_admin" }
    await expect(setCityState(emptySlug, "live")).rejects.toThrow(
      `Emptyville ${emptySlug} can’t go live: it has no upcoming listed events and no listed venues. List an event or a venue in Emptyville ${emptySlug} first.`
    )
    expect((await db.cities.findUnique({ where: { slug: emptySlug } }))?.launch_state).toBe("preview")
    expect(await auditRows((await db.cities.findUniqueOrThrow({ where: { slug: emptySlug } })).id)).toBe(0)
  })

  it("lets a city with an upcoming listed event go live, and shows its supply", async () => {
    actingUser = { id: admin, role: "app_admin" }
    await setCityState(suppliedSlug, "live")
    expect((await db.cities.findUnique({ where: { slug: suppliedSlug } }))?.launch_state).toBe("live")
    const view = await getMarkets()
    const city = view.markets.find((m) => m.code === CODE)?.cities.find((c) => c.slug === suppliedSlug)
    expect(city).toMatchObject({ launchState: "live", effectiveState: "live", upcomingEvents: 1, venues: 0 })
    await setCityState(suppliedSlug, "preview")
  })

  it("refuses a market going live while one of its live cities has no supply", async () => {
    actingUser = { id: admin, role: "app_admin" }
    await setMarketState(CODE, "hidden")
    await db.cities.update({ where: { slug: emptySlug }, data: { launch_state: "live" } })
    await expect(setMarketState(CODE, "live")).rejects.toThrow(`Testland can’t go live: Emptyville ${emptySlug} is set to live with nothing listed.`)
    expect((await db.markets.findUnique({ where: { code: CODE } }))?.launch_state).toBe("hidden")
    await db.cities.update({ where: { slug: emptySlug }, data: { launch_state: "preview" } })
    await setMarketState(CODE, "live")
  })
})

describe("each action writes exactly one audit row, and the app sees it at once", () => {
  it("a city's state: one row, and the catalogue cache cleared on save", async () => {
    actingUser = { id: admin, role: "app_admin" }
    const id = (await db.cities.findUniqueOrThrow({ where: { slug: suppliedSlug } })).id
    const before = await auditRows(id)
    expect((await cityCatalogue()).cities.find((c) => c.slug === suppliedSlug)?.launchState).toBe("preview")
    await setCityState(suppliedSlug, "hidden")
    expect(await auditRows(id)).toBe(before + 1)
    const row = await db.audit_logs.findFirstOrThrow({ where: { resource_id: id }, orderBy: { created_at: "desc" } })
    expect(row).toMatchObject({ user_id: admin, action: "city.state_changed", resource: "city", details: { from: "preview", to: "hidden", slug: suppliedSlug } })
    // No clearCityCatalogue() here: the save did it.
    expect((await cityCatalogue()).cities.find((c) => c.slug === suppliedSlug)?.launchState).toBe("hidden")
    await setCityState(suppliedSlug, "preview")
  })

  it("a market's state: one row", async () => {
    actingUser = { id: admin, role: "app_admin" }
    const before = await auditRows(CODE)
    await setMarketState(CODE, "preview")
    expect(await auditRows(CODE)).toBe(before + 1)
    expect((await cityCatalogue()).markets.find((m) => m.code === CODE)?.launchState).toBe("preview")
    await setMarketState(CODE, "live")
  })

  it("setting the state it already has writes nothing", async () => {
    actingUser = { id: admin, role: "app_admin" }
    const before = await auditRows(CODE)
    await setMarketState(CODE, "live")
    expect(await auditRows(CODE)).toBe(before)
  })

  it("a new city: one row, hidden, its zone and age kept", async () => {
    actingUser = { id: admin, role: "app_admin" }
    const slug = slugOf("new")
    await createCity(cityInput(slug, "Newton"))
    const city = await db.cities.findUniqueOrThrow({ where: { slug } })
    expect(city).toMatchObject({ launch_state: "hidden", timezone: "America/Toronto", default_licensed_min_age: 19, match_names: ["newton"], is_default: false })
    expect(await auditRows(city.id)).toBe(1)
    expect((await cityCatalogue()).cities.some((c) => c.slug === slug)).toBe(true)
  })

  it("a new country: one row, hidden", async () => {
    actingUser = { id: admin, role: "app_admin" }
    await createMarket({ code: NEW_CODE, name: "Newland", currency: "EUR", locale: "de-DE" })
    expect(await db.markets.findUnique({ where: { code: NEW_CODE } })).toMatchObject({ launch_state: "hidden", currency: "EUR", locale: "de-DE" })
    expect(await auditRows(NEW_CODE)).toBe(1)
  })

  it("a previewer added and removed: one row each, and their preview access follows at once", async () => {
    actingUser = { id: admin, role: "app_admin" }
    await setMarketState(CODE, "preview")
    const catalogue = await cityCatalogue()
    expect((await previewMarketsFor(attendee, catalogue)).has(CODE)).toBe(false)

    await addPreviewer(CODE, `  ${attendee.toUpperCase()}@ITEST.INVALID `)
    expect(await db.market_previewers.count({ where: { market_code: CODE, user_id: attendee } })).toBe(1)
    expect(await db.audit_logs.count({ where: { action: "market.previewer_added", resource_id: CODE } })).toBe(1)
    expect((await previewMarketsFor(attendee, await cityCatalogue())).has(CODE)).toBe(true)

    await removePreviewer(CODE, attendee)
    expect(await db.market_previewers.count({ where: { market_code: CODE } })).toBe(0)
    expect(await db.audit_logs.count({ where: { action: "market.previewer_removed", resource_id: CODE } })).toBe(1)
    expect((await previewMarketsFor(attendee, await cityCatalogue())).has(CODE)).toBe(false)
    await setMarketState(CODE, "live")
  })
})

describe("what an admin types is checked before anything is written", () => {
  beforeEach(() => {
    actingUser = { id: admin, role: "app_admin" }
  })

  it.each([
    [{ timezone: "Mars/Olympus" }, "Not a timezone we know. Use the IANA name, like America/Toronto."],
    [{ slug: "Not A Slug" }, "Lowercase letters, numbers and hyphens, like toronto."],
    [{ name: " " }, "Name the city."],
    [{ matchNames: " , " }, "At least one spelling, comma-separated."],
    [{ minLat: 12 }, "Min must be less than max."],
    [{ centreLat: 30 }, "The centre must sit inside the bounds."],
    [{ licensedMinAge: "17" }, "A whole number from 18 to 21, or leave it empty."],
  ])("refuses a city with %j", async (patch, message) => {
    const before = await snapshot()
    await expect(createCity({ ...cityInput(slugOf("bad")), ...patch })).rejects.toThrow(message)
    expect(await snapshot()).toEqual(before)
  })

  it("refuses a city whose slug is taken, or whose market does not exist", async () => {
    await expect(createCity(cityInput(suppliedSlug))).rejects.toThrow("That slug is taken.")
    await expect(createCity({ ...cityInput(slugOf("orphan")), marketCode: "XZ" })).rejects.toThrow("Choose a country from the list.")
  })

  it.each([
    [{ code: "xr1" }, "Two capital letters, like DE."],
    [{ code: CODE }, "Testland is already a market."],
    [{ currency: "EU" }, "Three capital letters, like EUR."],
    [{ locale: "german" }, "A language and region, like de-DE."],
  ])("refuses a country with %j", async (patch, message) => {
    await expect(createMarket({ code: "XS", name: "Elsewhere", currency: "EUR", locale: "de-DE", ...patch })).rejects.toThrow(message)
    expect(await db.markets.count({ where: { code: { in: ["XS", "xr1"] } } })).toBe(0)
  })

  it("refuses a previewer email with no account, and a second add of the same person", async () => {
    await expect(addPreviewer(CODE, "nobody-here@itest.invalid")).rejects.toThrow("No Blendn account uses that email.")
    await addPreviewer(CODE, `${organiser}@itest.invalid`)
    await expect(addPreviewer(CODE, `${organiser}@itest.invalid`)).rejects.toThrow(`${organiser}@itest.invalid already previews Testland.`)
    await removePreviewer(CODE, organiser)
  })

  it("refuses an unknown state", async () => {
    await expect(setCityState(suppliedSlug, "open" as never)).rejects.toThrow("Choose Live, Preview or Hidden.")
  })
})
