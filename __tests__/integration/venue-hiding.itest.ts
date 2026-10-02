process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

// `jose` is ESM-only; see checkin.itest.ts.
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/tigris", () => ({ deletePrefix: jest.fn().mockResolvedValue(0) }))

import { venueDayFor } from "@/lib/venue-day"
import { venuesTakenOver } from "@/lib/venue-visibility"

import { closeDb, db, makeUser, testId } from "./helpers"
import { cleanupWorld, goLive, LAT, LNG, person, realEvent, req, venue, world } from "./go-live-world"

/* eslint-disable @typescript-eslint/no-require-imports */
const venueRoute = require("@/app/api/mobile/venues/[venueId]/route") as typeof import("@/app/api/mobile/venues/[venueId]/route")
const citiesRoute = require("@/app/api/mobile/events/cities/route") as typeof import("@/app/api/mobile/events/cities/route")
const venuesRoute = require("@/app/api/mobile/venues/route") as typeof import("@/app/api/mobile/venues/route")
const eventsRoute = require("@/app/api/mobile/events/route") as typeof import("@/app/api/mobile/events/route")
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Places hides a venue while a real event has it (plan v2 step 2; TQ-A07,
 * HM-I01..I04, HM-I06). The rule is step 4's (`lib/venue-visibility.ts`):
 * from an hour before a published, public, undisputed event starts until it
 * ends, per occurrence, for an event the viewer may attend, linked by a
 * confirmed link or with its area at the venue. Every venue a case expects
 * hidden is paired with one it expects listed from the same request, so an
 * absence never only proves the query found nothing.
 *
 * The routes read the wall clock, so windows are placed around now.
 */

const MIN = 60_000
const TOKEN = `zvh${Date.now().toString(36).replace(/\d/g, "")}q`

afterAll(async () => {
  await cleanupWorld()
  await closeDb()
}, 120_000)

/** A fixture venue the `TOKEN` search finds, named so a failure says which. */
async function place(label: string, opts: Parameters<typeof venue>[0] = {}) {
  const id = await venue(opts)
  await db.venues.update({ where: { id }, data: { name: `${TOKEN} ${label}` } })
  return id
}

type Row = {
  id: string
  name: string
  liveNow: string | null
  upcomingEventCount: number
  nextEvent: { id: string } | null
}

async function places(token: string, query = "") {
  const res = await venuesRoute.GET(req(`/api/mobile/venues?search=${TOKEN}&limit=100${query}`, token))
  const text = await res.text()
  expect(res.status).toBe(200)
  return { rows: JSON.parse(text).data.venues as Row[], text }
}

const listed = (rows: Row[], id: string) => rows.some((r) => r.id === id)

describe("GET /venues hides a venue a real event has taken over (HM-I01)", () => {
  it("from an hour before the start: hidden at 59 minutes, listed at 61", async () => {
    const [soon, later] = [await place("soon"), await place("later")]
    await realEvent(soon, { startsInMin: 59, link: "confirmed" })
    await realEvent(later, { startsInMin: 61, link: "confirmed" })
    const { rows } = await places((await person()).token)
    expect(listed(rows, soon)).toBe(false)
    expect(listed(rows, later)).toBe(true)
  })

  it("until the end: hidden while it runs, listed once it has ended", async () => {
    const [running, ended] = [await place("running"), await place("ended")]
    await realEvent(running, { startsInMin: -30, link: "confirmed" })
    await realEvent(ended, { startsInMin: -61, hours: 1, link: "confirmed" })
    const { rows } = await places((await person()).token)
    expect(listed(rows, running)).toBe(false)
    expect(listed(rows, ended)).toBe(true)
  })

  it.each([
    ["a NULL link, its area at the venue", false, { link: null }],
    ["an auto-link, its area at the venue", false, { link: "auto_linked" as const }],
    ["an auto-link, its area a kilometre away", true, { link: "auto_linked" as const, far: true }],
    ["a confirmed link, its area a kilometre away", false, { link: "confirmed" as const, far: true }],
    ["a disputed link", true, { link: "disputed" as const }],
    ["a private event", true, { link: "confirmed" as const, visibility: "private" as const }],
    ["a day of it called off", true, { link: "confirmed" as const, cancelled: true }],
  ])("an event running now with %s → listed: %s", async (label, expected, opts) => {
    const v = await place(label)
    const control = await place(`${label} control`)
    await realEvent(v, { startsInMin: -30, ...opts })
    const { rows } = await places((await person()).token)
    expect(listed(rows, v)).toBe(expected)
    expect(listed(rows, control)).toBe(true)
  })

  it.each([
    ["a draft", { status: "draft" as const }],
    ["cancelled", { status: "cancelled" as const }],
    ["deleted", { deleted_at: new Date() }],
  ])("never hides behind %s event (HM-U02)", async (label, change) => {
    const [v, hiding] = [await place(label), await place(`${label} hiding`)]
    const gone = await realEvent(v, { startsInMin: -30, link: "confirmed" })
    await db.events.update({ where: { id: gone }, data: change })
    await realEvent(hiding, { startsInMin: -30, link: "confirmed" })
    const { rows } = await places((await person()).token)
    expect(listed(rows, v)).toBe(true)
    expect(listed(rows, hiding)).toBe(false)
  })

  it("is never hidden by its own venue day (F3), and says how many are live as a bucket", async () => {
    const v = await place("live")
    const five = [await person(), await person(), await person(), await person(), await person()]
    for (const p of five) expect((await goLive(p.token, v)).status).toBe(200)

    const { rows, text } = await places((await person()).token)
    expect(rows.find((r) => r.id === v)).toMatchObject({ liveNow: "5-9", upcomingEventCount: 0, nextEvent: null })
    // Never the area, never a count (HM-C02, SEC-19).
    expect(text).not.toMatch(/geofence|radius|"ring"|owner_org_id/)
    // One of the five: four others, never themselves (step 4's rule).
    const theirs = (await places(five[0].token)).rows.find((r) => r.id === v)
    expect(theirs?.liveNow).toBe("quiet")
  })

  it("hides per occurrence: listed between the days of a run, hidden an hour before the next (D-2)", async () => {
    const [between, next] = [await place("between days"), await place("next day soon")]
    const run = async (venueId: string, nextInMin: number) => {
      const host = await makeUser(testId("vh_host"), "organizer")
      world.users.push(host)
      const now = Date.now()
      const days = [
        { start: now - 20 * 60 * MIN, end: now - 12 * 60 * MIN },
        { start: now + nextInMin * MIN, end: now + (nextInMin + 8 * 60) * MIN },
      ]
      const event = await db.events.create({
        data: {
          slug: testId("vh_run"),
          title: testId("Festival"),
          description: "integration fixture",
          start_time: new Date(days[0].start),
          end_time: new Date(days[1].end),
          timezone: "UTC",
          status: "published",
          visibility: "public",
          organizer_id: host,
          venue_id: venueId,
          venue_link_status: "confirmed",
          latitude: LAT,
          longitude: LNG,
        },
      })
      for (const d of days) {
        await db.event_occurrences.create({
          data: {
            event_id: event.id,
            occurs_on: new Date(new Date(d.start).toISOString().slice(0, 10)),
            start_time: new Date(d.start),
            end_time: new Date(d.end),
          },
        })
      }
    }
    await run(between, 10 * 60)
    await run(next, 30)
    const { rows } = await places((await person()).token)
    expect(listed(rows, between)).toBe(true)
    expect(listed(rows, next)).toBe(false)
  })
})

describe("the viewer's age, beside the search (HM-I02, D-3, F4)", () => {
  it("hides a venue behind a 21+ night only from somebody who may go in", async () => {
    const v = await place("over 21")
    const night = await realEvent(v, { startsInMin: -30, link: "confirmed", minAge: 21 })
    // `search` is an OR on the venue; the age is an OR inside the rule. Both hold.
    expect(listed((await places((await person("vh30")).token)).rows, v)).toBe(false)
    const young = (await places((await person("vh19", { age: 19 })).token)).rows.find((r) => r.id === v)
    expect(young).toBeDefined()
    // And the night they cannot enter is not the card's headline either.
    expect(young?.nextEvent?.id).not.toBe(night)
  })

  it("never headlines a disputed event, nor counts it, on the venue it disputes", async () => {
    const v = await place("disputes")
    await realEvent(v, { startsInMin: 120, link: "disputed" })
    const row = (await places((await person()).token)).rows.find((r) => r.id === v)
    expect(row).toMatchObject({ upcomingEventCount: 0, nextEvent: null })
  })
})

describe("GET /events: a card names its venue (HM-I04, HM-U08)", () => {
  it("as {id, name} by the takeover's own test; null when disputed, far and auto-linked, archived, or there is none", async () => {
    const [linked, disputed, archived] = [await place("linked"), await place("disputed card"), await place("archived")]
    const [autoNear, autoFar, confirmedFar] = [await place("auto near"), await place("auto far"), await place("confirmed far")]
    const named = async (
      venueId: string | null,
      link: "auto_linked" | "confirmed" | "disputed" | null,
      label: string,
      far = false
    ) => {
      const id = venueId
        ? await realEvent(venueId, { startsInMin: 180, link, far })
        : await realEvent(linked, { startsInMin: 180 }).then(async (e) => {
            await db.events.update({ where: { id: e }, data: { venue_id: null } })
            return e
          })
      await db.events.update({ where: { id }, data: { title: `${TOKEN} ${label}`, venue_name: `${label} free text` } })
      return id
    }
    const ids = {
      linked: await named(linked, "confirmed", "linked"),
      disputed: await named(disputed, "disputed", "disputed"),
      archived: await named(archived, "confirmed", "archived"),
      none: await named(null, null, "none"),
      autoNear: await named(autoNear, "auto_linked", "auto near"),
      // Any organiser can auto-link any venue; a kilometre away it lends them no name.
      autoFar: await named(autoFar, "auto_linked", "auto far", true),
      confirmedFar: await named(confirmedFar, "confirmed", "confirmed far", true),
    }
    await db.venues.update({ where: { id: archived }, data: { status: "archived" } })

    const res = await eventsRoute.GET(req(`/api/mobile/events?search=${TOKEN}&limit=50`, (await person()).token))
    expect(res.status).toBe(200)
    const text = await res.text()
    const cards = JSON.parse(text).data.events as Array<{ id: string; venue: unknown; venueName: string }>
    const card = (id: string) => cards.find((c) => c.id === id)

    expect(card(ids.linked)?.venue).toEqual({ id: linked, name: `${TOKEN} linked` })
    expect(card(ids.disputed)).toMatchObject({ venue: null, venueName: "disputed free text" })
    expect(card(ids.archived)?.venue).toBeNull()
    expect(card(ids.none)?.venue).toBeNull()
    expect(card(ids.autoNear)?.venue).toEqual({ id: autoNear, name: `${TOKEN} auto near` })
    expect(card(ids.autoFar)).toMatchObject({ venue: null, venueName: "auto far free text" })
    expect(card(ids.confirmedFar)?.venue).toEqual({ id: confirmedFar, name: `${TOKEN} confirmed far` })
    // `{id, name}` only: never the venue's area or its owner.
    expect(text).not.toMatch(/geofence|owner_org_id|"ring"/)
  })
})

describe("GET /venues refuses a bad viewport (HM-I06)", () => {
  it.each(["radius=1e9", "radius=-1", "radius=NaN", "lat=200&lon=77&radius=5"])("%s → 400, never 500", async (q) => {
    const res = await venuesRoute.GET(req(`/api/mobile/venues?${q}`, (await person()).token))
    expect(res.status).toBe(400)
  })
})

/** `n` guests (or staff) live at the venue's day now, written straight in: no Go Live per person. */
async function liveAt(venueId: string, n: number, kind: "attendee" | "staff" = "attendee") {
  const day = await venueDayFor(venueId)
  if (!day) throw new Error("no venue day")
  for (let i = 0; i < n; i++) {
    const user = await makeUser(testId("vh_live"))
    world.users.push(user)
    await db.event_check_ins.create({
      data: {
        event_id: day.id,
        occurrence_id: day.occurrenceId,
        user_id: user,
        kind,
        status: "checked_in",
        check_in_time: new Date(),
        expires_at: new Date(Date.now() + 60 * MIN),
      },
    })
  }
}

async function detailLiveNow(token: string, venueId: string) {
  const res = await venueRoute.GET(req(`/api/mobile/venues/${venueId}`, token), { params: Promise.resolve({ venueId }) })
  expect(res.status).toBe(200)
  return (await res.json()).data.live.liveNow as string
}

describe("the window's edges, at a fixed now (HM-U01)", () => {
  it("is open from exactly an hour before the start until the instant before the end", async () => {
    const v = await place("fixed now")
    const start = new Date(Math.ceil((Date.now() + 5 * 60 * MIN) / MIN) * MIN)
    const end = new Date(start.getTime() + 120 * MIN)
    const id = await realEvent(v, { startsInMin: 0, link: "confirmed" })
    await db.events.update({ where: { id }, data: { start_time: start, end_time: end } })
    await db.event_occurrences.updateMany({ where: { event_id: id }, data: { start_time: start, end_time: end } })
    const at = async (ms: number) => (await venuesTakenOver(new Date(ms), { id: v })).includes(v)
    expect(await at(start.getTime() - 61 * MIN)).toBe(false)
    expect(await at(start.getTime() - 60 * MIN)).toBe(true)
    expect(await at(end.getTime() - 1)).toBe(true)
    expect(await at(end.getTime())).toBe(false)
  })
})

describe("liveNow on the list (D-19, F14, step 2 review)", () => {
  it.each([
    [4, "quiet"],
    [5, "5-9"],
    [9, "5-9"],
    [10, "10-19"],
    [19, "10-19"],
    [20, "20+"],
  ])("%s guests read %s", async (n, bucket) => {
    const v = await place(`edge ${n}`)
    await liveAt(v, n)
    const { rows } = await places((await person()).token)
    expect(rows.find((r) => r.id === v)?.liveNow).toBe(bucket)
  })

  it("agrees with the venue page, and never counts the venue's staff", async () => {
    const [five, staffed] = [await place("agrees"), await place("staffed")]
    await liveAt(five, 5)
    await liveAt(staffed, 4)
    await liveAt(staffed, 1, "staff")
    const viewer = await person()
    const { rows } = await places(viewer.token)
    expect(rows.find((r) => r.id === five)?.liveNow).toBe("5-9")
    expect(await detailLiveNow(viewer.token, five)).toBe("5-9")
    expect(rows.find((r) => r.id === staffed)?.liveNow).toBe("quiet")
    expect(await detailLiveNow(viewer.token, staffed)).toBe("quiet")
  })

  it("does not move when you go live yourself inside the minute: the edge your arrival crossed stays hidden", async () => {
    const v = await place("go live, re-read")
    await liveAt(v, 5)
    const me = await person()
    expect((await places(me.token)).rows.find((r) => r.id === v)?.liveNow).toBe("5-9")
    expect((await goLive(me.token, v)).status).toBe(200)
    // The figure was read without you; subtracting you from it would say "quiet" — four others, exactly.
    expect((await places(me.token)).rows.find((r) => r.id === v)?.liveNow).toBe("5-9")
    expect(await detailLiveNow(me.token, v)).toBe("5-9")
  })

  it.each([
    ["an unknown age", { age: null }],
    ["under 18", { age: 16 }],
  ])("is null for %s, whom the venue page would refuse", async (_label, opts) => {
    const v = await place(`gate ${_label}`)
    await liveAt(v, 5)
    const { rows } = await places((await person("vhgate", opts)).token)
    expect(rows.find((r) => r.id === v)?.liveNow).toBeNull()
  })
})

describe("whom a venue is hidden from (D-3)", () => {
  it("hides behind a 21+ night from somebody of unknown age: discovery hides nothing from them", async () => {
    const v = await place("unknown age")
    await realEvent(v, { startsInMin: -30, link: "confirmed", minAge: 21 })
    expect(listed((await places((await person("vhunk", { age: null })).token)).rows, v)).toBe(false)
  })

  it("hides from a 19-year-old when an all-ages night shares the venue with a 21+ one", async () => {
    const v = await place("mixed ages")
    await realEvent(v, { startsInMin: -30, link: "confirmed", minAge: 21 })
    await realEvent(v, { startsInMin: -20, link: "confirmed" })
    expect(listed((await places((await person("vh19b", { age: 19 })).token)).rows, v)).toBe(false)
  })
})

describe("paging around a taken-over venue", () => {
  it("counts only what is listed: totalCount and hasMore leave the hidden venue out", async () => {
    const sub = `${TOKEN}pg`
    const ids = [await place("pg a"), await place("pg b"), await place("pg c")]
    for (const id of ids) await db.venues.update({ where: { id }, data: { name: `${sub} ${id}` } })
    await realEvent(ids[0], { startsInMin: -30, link: "confirmed" })
    const token = (await person()).token
    const page = async (n: number) =>
      JSON.parse(await (await venuesRoute.GET(req(`/api/mobile/venues?search=${sub}&limit=1&page=${n}`, token))).text()).data
    const [one, two] = [await page(1), await page(2)]
    expect(one.pagination).toMatchObject({ totalCount: 2, hasMore: true })
    expect(two.pagination).toMatchObject({ totalCount: 2, hasMore: false })
    expect([...one.venues, ...two.venues].map((v: Row) => v.id).sort()).toEqual([ids[1], ids[2]].sort())
  })

  it("keeps one order for venues with one name, and never repeats a venue when one is taken over between pages", async () => {
    const name = `${TOKEN}same`
    const ids = [await place("same 1"), await place("same 2"), await place("same 3")]
    for (const id of ids) await db.venues.update({ where: { id }, data: { name } })
    const sorted = [...ids].sort()
    const token = (await person()).token
    const page = async (n: number) =>
      (JSON.parse(await (await venuesRoute.GET(req(`/api/mobile/venues?search=${name}&limit=1&page=${n}`, token))).text()).data
        .venues as Row[]).map((v) => v.id)
    // Ties by id: the same order on every read.
    expect([...(await page(1)), ...(await page(2)), ...(await page(3))]).toEqual(sorted)
    const first = await page(1)
    await realEvent(first[0], { startsInMin: -30, link: "confirmed" })
    // Offsets shift left: page 2 may skip a venue (the app pages on), never repeat one.
    expect(first).not.toContain((await page(2))[0])
  })

  it("leaves the venue out of the distance sort too", async () => {
    const [taken, open] = [await place("distance taken"), await place("distance open")]
    await realEvent(taken, { startsInMin: -30, link: "confirmed" })
    const { rows } = await places((await person()).token, `&lat=${LAT}&lon=${LNG}&radius=5&sortBy=distance`)
    expect(listed(rows, taken)).toBe(false)
    expect(listed(rows, open)).toBe(true)
  })
})

describe("GET /venues is limited per person", () => {
  it("answers 429 from the 61st read in a minute", async () => {
    const me = await person()
    const statuses: number[] = []
    for (let i = 0; i < 61; i++) statuses.push((await venuesRoute.GET(req(`/api/mobile/venues?search=${TOKEN}zzz&limit=1`, me.token))).status)
    expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true)
    expect(statuses[60]).toBe(429)
  })
})

describe("GET /events/cities carries where to point the map (step 2 review)", () => {
  it("gives each city the mean of its events' points", async () => {
    const city = `Itest${TOKEN}`
    const v = await place("city centre")
    for (const [startsInMin, lat] of [[120, LAT], [180, LAT + 0.002]] as const) {
      const id = await realEvent(v, { startsInMin })
      await db.events.update({ where: { id }, data: { city, latitude: lat, longitude: LNG } })
    }
    const res = await citiesRoute.GET(req("/api/mobile/events/cities", (await person()).token))
    const row = (JSON.parse(await res.text()).data.cities as Array<{ city: string; centre: unknown }>).find((c) => c.city === city)
    expect(row?.centre).toEqual({ latitude: Math.round((LAT + 0.001) * 1e4) / 1e4, longitude: LNG })
  })
})
