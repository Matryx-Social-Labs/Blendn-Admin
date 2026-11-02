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

const venues: string[] = []

// Runs whether or not the test passed, so a failure never leaks a previewer or a state into the next test.
afterEach(async () => {
  actingUser = null
  await db.market_previewers.deleteMany({ where: { market_code: CODE } })
  await db.cities.updateMany({ where: { slug: { in: [emptySlug, suppliedSlug] } }, data: { launch_state: "preview" } })
  await db.markets.update({ where: { code: CODE }, data: { launch_state: "live" } })
  await db.events.updateMany({ where: { id: { in: events.slice(1) } }, data: { deleted_at: new Date() } })
  await db.venues.updateMany({ where: { id: { in: venues } }, data: { deleted_at: new Date() } })
})

afterAll(async () => {
  await db.audit_logs.deleteMany({ where: { user_id: { in: users } } })
  await db.market_previewers.deleteMany({ where: { market_code: { in: [CODE, NEW_CODE] } } })
  await db.venues.deleteMany({ where: { id: { in: venues } } })
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

  it("counts an event at the age floor and not one above it: a 19+ night is not something every viewer can open", async () => {
    actingUser = { id: admin, role: "app_admin" }
    const eventId = await makeEvent(organiser)
    events.push(eventId)
    await db.events.update({ where: { id: eventId }, data: { city: `Emptyville ${emptySlug}`, min_age: 19 } })
    await expect(setCityState(emptySlug, "live")).rejects.toThrow("can’t go live")
    await db.events.update({ where: { id: eventId }, data: { min_age: 18 } })
    await setCityState(emptySlug, "live")
    expect((await db.cities.findUnique({ where: { slug: emptySlug } }))?.launch_state).toBe("live")
  })

  it("counts a listed venue as supply, with no event at all", async () => {
    actingUser = { id: admin, role: "app_admin" }
    const venue = await db.venues.create({ data: { name: testId("venue"), city: `Emptyville ${emptySlug}`, status: "active" }, select: { id: true } })
    venues.push(venue.id)
    const view = async () => (await getMarkets()).markets.find((m) => m.code === CODE)!.cities.find((c) => c.slug === emptySlug)!
    expect(await view()).toMatchObject({ upcomingEvents: 0, venues: 1 })
    await setCityState(emptySlug, "live")
    expect((await db.cities.findUnique({ where: { slug: emptySlug } }))?.launch_state).toBe("live")
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
    expect(row).toMatchObject({ user_id: admin, action: "city.state_changed", resource: "city" })
    expect(row.details).toEqual({ slug: suppliedSlug, from: "preview", to: "hidden" })
    // No clearCityCatalogue() here: the save did it.
    expect((await cityCatalogue()).cities.find((c) => c.slug === suppliedSlug)?.launchState).toBe("hidden")
    await setCityState(suppliedSlug, "preview")
  })

  it("a market's state: one row", async () => {
    actingUser = { id: admin, role: "app_admin" }
    const before = await auditRows(CODE)
    // Warm: the read after the save must come from a cache the save cleared, not from a cold one.
    expect((await cityCatalogue()).markets.find((m) => m.code === CODE)?.launchState).toBe("live")
    await setMarketState(CODE, "preview")
    expect(await auditRows(CODE)).toBe(before + 1)
    expect((await cityCatalogue()).markets.find((m) => m.code === CODE)?.launchState).toBe("preview")
    const row = await db.audit_logs.findFirstOrThrow({ where: { resource_id: CODE, action: "market.state_changed" }, orderBy: { created_at: "desc" } })
    expect(row.details).toEqual({ from: "live", to: "preview" })
  })

  it("setting the state it already has writes nothing, for a market and for a city", async () => {
    actingUser = { id: admin, role: "app_admin" }
    const cityId = (await db.cities.findUniqueOrThrow({ where: { slug: suppliedSlug } })).id
    const [market, city] = [await auditRows(CODE), await auditRows(cityId)]
    await setMarketState(CODE, "live")
    await setCityState(suppliedSlug, "preview")
    expect([await auditRows(CODE), await auditRows(cityId)]).toEqual([market, city])
  })

  it("refuses what does not exist, and writes nothing", async () => {
    actingUser = { id: admin, role: "app_admin" }
    const before = await snapshot()
    await expect(setCityState("no-such-city-here", "live")).rejects.toThrow("No such city.")
    await expect(setMarketState("XZ", "live")).rejects.toThrow("No such country.")
    await expect(addPreviewer("XZ", `${attendee}@itest.invalid`)).rejects.toThrow("No such country.")
    await expect(removePreviewer(CODE, attendee)).rejects.toThrow("They don’t preview this country.")
    expect(await snapshot()).toEqual(before)
  })

  it("a new city: one row, hidden, its zone and age kept", async () => {
    actingUser = { id: admin, role: "app_admin" }
    const slug = slugOf("new")
    expect((await cityCatalogue()).cities.some((c) => c.slug === slug)).toBe(false)
    await createCity(cityInput(slug, "Newton"))
    const city = await db.cities.findUniqueOrThrow({ where: { slug } })
    expect(city).toMatchObject({ launch_state: "hidden", timezone: "America/Toronto", default_licensed_min_age: 19, match_names: ["newton"], is_default: false })
    expect(await auditRows(city.id)).toBe(1)
    expect((await db.audit_logs.findFirstOrThrow({ where: { resource_id: city.id } })).details).toEqual({
      slug,
      market: CODE,
      timezone: "America/Toronto",
      tookOffline: { events: 0, venues: 0 },
    })
    expect((await cityCatalogue()).cities.some((c) => c.slug === slug)).toBe(true)
  })

  it("a new city that listed rows already name: refused until the admin agrees to take them offline", async () => {
    actingUser = { id: admin, role: "app_admin" }
    const slug = slugOf("named")
    const name = `Offlineton ${slug}`
    const eventId = await makeEvent(organiser)
    events.push(eventId)
    await db.events.update({ where: { id: eventId }, data: { city: name } })
    const input = { ...cityInput(slug, name), matchNames: name }
    await expect(createCity(input)).rejects.toThrow(`1 listed events and 0 venues already list ${name}.`)
    expect(await db.cities.count({ where: { slug } })).toBe(0)
    await createCity({ ...input, takeOffline: true })
    const city = await db.cities.findUniqueOrThrow({ where: { slug } })
    expect(await db.audit_logs.findFirst({ where: { resource_id: city.id } })).toMatchObject({ details: { tookOffline: { events: 1, venues: 0 } } })
  })

  it("a new city with no region, and a zone typed in lower case: kept as null and as Intl names it", async () => {
    actingUser = { id: admin, role: "app_admin" }
    const slug = slugOf("plain")
    const { region: _region, ...noRegion } = cityInput(slug, `Plainfield ${slug}`)
    await createCity({ ...noRegion, matchNames: `plainfield ${slug}`, timezone: "america/toronto" })
    expect(await db.cities.findUnique({ where: { slug } })).toMatchObject({ region: null, timezone: "America/Toronto" })
  })

  it("a new country: one row, hidden", async () => {
    actingUser = { id: admin, role: "app_admin" }
    expect((await cityCatalogue()).markets.some((m) => m.code === NEW_CODE)).toBe(false)
    await createMarket({ code: NEW_CODE, name: "Newland", currency: "EUR", locale: "de-DE" })
    expect(await db.markets.findUnique({ where: { code: NEW_CODE } })).toMatchObject({ launch_state: "hidden", currency: "EUR", locale: "de-DE" })
    expect(await auditRows(NEW_CODE)).toBe(1)
    expect((await db.audit_logs.findFirstOrThrow({ where: { resource_id: NEW_CODE } })).details).toEqual({ code: NEW_CODE, name: "Newland", currency: "EUR", locale: "de-DE" })
    expect((await cityCatalogue()).markets.some((m) => m.code === NEW_CODE)).toBe(true)
  })

  it("a previewer added and removed: one row each, and their preview access follows at once", async () => {
    actingUser = { id: admin, role: "app_admin" }
    await setMarketState(CODE, "preview")
    const catalogue = await cityCatalogue()
    expect((await previewMarketsFor(attendee, catalogue)).has(CODE)).toBe(false)

    await addPreviewer(CODE, `  ${attendee.toUpperCase()}@ITEST.INVALID `)
    expect(await db.market_previewers.count({ where: { market_code: CODE, user_id: attendee } })).toBe(1)
    const added = await db.audit_logs.findMany({ where: { action: "market.previewer_added", resource_id: CODE } })
    expect(added.map((r) => r.details)).toEqual([{ previewerId: attendee }])
    expect((await previewMarketsFor(attendee, await cityCatalogue())).has(CODE)).toBe(true)

    await removePreviewer(CODE, attendee)
    expect(await db.market_previewers.count({ where: { market_code: CODE } })).toBe(0)
    const removed = await db.audit_logs.findMany({ where: { action: "market.previewer_removed", resource_id: CODE } })
    expect(removed.map((r) => r.details)).toEqual([{ previewerId: attendee }])
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
    [{ licensedMinAge: "22" }, "A whole number from 18 to 21, or leave it empty."],
    [{ centreLat: 91, minLat: 10, maxLat: 11 }, "Latitude is between -90 and 90."],
    [{ minLon: -181 }, "Longitude is between -180 and 180."],
    [{ maxLon: "east" }, "Longitude is between -180 and 180."],
    [{ minLat: "" }, "Latitude is between -90 and 90."],
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

  it("matches the typed address exactly: a % or _ in it is a character, never a wildcard that finds somebody else", async () => {
    // The attendee's address with one letter turned into _, and a bare %: both would match them under ILIKE.
    const real = `${attendee}@itest.invalid`
    const underscored = real.replace(/[a-z0-9](?=@)/, "_")
    for (const typed of [underscored, "%@itest.invalid", `${attendee.slice(0, 8)}%`]) {
      await expect(addPreviewer(CODE, typed)).rejects.toThrow("No Blendn account uses that email.")
    }
    expect(await db.market_previewers.count({ where: { market_code: CODE } })).toBe(0)
    // Control: the exact address, typed in another case, still finds them, and the answer names the stored address.
    await expect(addPreviewer(CODE, real.toUpperCase())).resolves.toEqual({ email: real })
    await removePreviewer(CODE, attendee)
  })

  it("refuses a previewer email with no account, and a second add of the same person", async () => {
    await expect(addPreviewer(CODE, "nobody-here@itest.invalid")).rejects.toThrow("No Blendn account uses that email.")
    await addPreviewer(CODE, `${organiser}@itest.invalid`)
    await expect(addPreviewer(CODE, `${organiser}@itest.invalid`)).rejects.toThrow(`${organiser}@itest.invalid already previews Testland.`)
    await removePreviewer(CODE, organiser)
  })

  it("refuses a Prisma operator where a string belongs, so a remove can never match everyone", async () => {
    await addPreviewer(CODE, `${organiser}@itest.invalid`)
    await expect(removePreviewer({ not: "" } as never, { not: "" } as never)).rejects.toThrow("That is not a valid value.")
    await expect(setCityState({ startsWith: "" } as never, "hidden")).rejects.toThrow("That is not a valid value.")
    await expect(createCity({ ...cityInput(slugOf("obj")), name: { toString: () => "x" } as never })).rejects.toThrow("That is not a valid value.")
    expect(await db.market_previewers.count({ where: { market_code: CODE } })).toBe(1)
    await removePreviewer(CODE, organiser)
  })

  it("refuses an unknown state", async () => {
    await expect(setCityState(suppliedSlug, "open" as never)).rejects.toThrow("Choose Live, Preview or Hidden.")
  })
})
