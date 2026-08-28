import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"

import { db, closeDb, makeUser, testId } from "./helpers"

/**
 * What may reach a phone, and what may not — E8.
 *
 * Four states must never appear in discovery: **draft**, **cancelled**,
 * **non-public**, and **deleted**. Each is a different kind of promise — an
 * unfinished event, a called-off one, a deliberately unlisted one, and one that
 * is gone — and all four fail the same silent way if a predicate is dropped:
 * the event simply shows up, looking exactly like every other event, and
 * nothing errors.
 *
 * There are **two** discovery surfaces and they are written in different
 * languages. `GET /events` builds a Prisma `where`; `GET /events/search` builds
 * raw SQL with `$queryRawUnsafe` because it needs `ts_rank`. So the same four
 * rules are expressed twice, in two syntaxes, with no shared code and nothing
 * making them agree — which is the "two surfaces, one question" shape the whole
 * audit is about. Both are asserted here, per state, for that reason.
 *
 * ## Age is deliberately asymmetric, and that is the subtle part
 *
 * An age-restricted event **is shown** to a viewer whose age is unknown, and
 * the **door** refuses them. That looks like a leak and is the opposite: age
 * lives on the profile, most people have not set one, and hiding every 18+
 * event from everybody who skipped a birthday field would empty the feed. So
 * discovery is permissive, `minAgeRefusal` is strict, and the copy tells them
 * what to fix. A test that asserted "18+ events are hidden from unknown-age
 * viewers" would be pinning a bug.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const listRoute = require("@/app/api/mobile/events/route") as
  typeof import("@/app/api/mobile/events/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const searchRoute = require("@/app/api/mobile/events/search/route") as
  typeof import("@/app/api/mobile/events/search/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const checkinRoute = require("@/app/api/mobile/events/[eventId]/checkin/route") as
  typeof import("@/app/api/mobile/events/[eventId]/checkin/route")

const users: string[] = []
const events: string[] = []
const HOUR = 60 * 60 * 1000

/** Bengaluru. The fixtures are centred here so the door can be reached. */
const LAT = 12.9784
const LNG = 77.6408

let organiser: string

/*
 * A search word unique to each *test*, not to the run — and the reason is a
 * cache, not tidiness.
 *
 * `GET /events` memoises on the filter inputs, and the key includes the derived
 * `viewerAge` but not the viewer. That is correct: two people with the same age
 * asking the same question deserve the same answer, and keying on identity
 * would make the cache useless. But it means two tests whose viewers both have
 * an unknown age and whose query strings match **share one entry** — so the
 * second test read a list assembled before its own fixture existed, and the
 * event it had just created was legitimately absent.
 *
 * Passing a per-test term separates the keys, and it scopes each assertion to
 * its own fixtures, which removes the cross-test interference this file would
 * otherwise have to reason about anyway.
 */
let counter = 0
const nextToken = () => `zqx${(counter += 1)}${Date.now().toString(36).replace(/\d/g, "")}q`

beforeAll(async () => {
  organiser = await makeUser(testId("dv_own"), "organizer")
  users.push(organiser)
})

afterAll(async () => {
  if (events.length) {
    await db.event_check_ins.deleteMany({ where: { event_id: { in: events } } })
    await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
    await db.events.deleteMany({ where: { id: { in: events } } })
  }
  if (users.length) await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

async function event(
  token: string,
  opts: {
    status?: "draft" | "published" | "cancelled" | "completed"
    visibility?: "public" | "private" | "unlisted"
    deleted?: boolean
    minAge?: number | null
    endedHoursAgo?: number
  } = {}
) {
  const now = Date.now()
  const ended = opts.endedHoursAgo ?? 0
  const row = await db.events.create({
    data: {
      slug: testId("dv"),
      // The searchable word. `to_tsquery` needs a real token, so it is a made-up
      // one rather than "test", which would match half the fixture database.
      title: `${token} gathering`,
      description: `${token} gathering`,
      start_time: new Date(now - HOUR - ended * HOUR),
      end_time: new Date(ended ? now - ended * HOUR : now + 3 * HOUR),
      timezone: "UTC",
      status: opts.status ?? "published",
      visibility: opts.visibility ?? "public",
      organizer_id: organiser,
      latitude: LAT,
      longitude: LNG,
      min_age: opts.minAge ?? null,
      ...(opts.deleted ? { deleted_at: new Date() } : {}),
    },
  })
  events.push(row.id)
  await db.event_occurrences.create({
    data: {
      event_id: row.id,
      occurs_on: new Date(row.start_time.toISOString().slice(0, 10)),
      start_time: row.start_time,
      end_time: row.end_time,
    },
  })
  return row.id
}

async function viewer(label: string, dateOfBirth?: Date) {
  const id = await makeUser(testId(label))
  users.push(id)
  const user = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
  // `profiles.id` IS the user id — there is no separate `user_id` column.
  await db.profiles.create({
    data: { id, ...(dateOfBirth ? { date_of_birth: dateOfBirth } : {}) },
  })
  return { id, token: signAccessToken(id, user.email) }
}

async function listedIds(auth: string, token: string): Promise<string[]> {
  const res = await listRoute.GET(
    new NextRequest(`http://localhost/api/mobile/events?limit=100&search=${token}`, {
      headers: { authorization: `Bearer ${auth}` },
    })
  )
  expect(res.status).toBe(200)
  const body = await res.json()
  const rows = Array.isArray(body.data) ? body.data : (body.data.events ?? [])
  return rows.map((e: { id: string }) => e.id)
}

async function searchedIds(auth: string, token: string): Promise<string[]> {
  const res = await searchRoute.GET(
    new NextRequest(`http://localhost/api/mobile/events/search?q=${token}&limit=100`, {
      headers: { authorization: `Bearer ${auth}` },
    })
  )
  expect(res.status).toBe(200)
  const body = await res.json()
  const rows = Array.isArray(body.data) ? body.data : (body.data.events ?? body.data.results ?? [])
  return rows.map((e: { id: string }) => e.id)
}

describe("what reaches a phone", () => {
  it("shows a published public event on both surfaces — the control", async () => {
    /*
     * Every assertion below is an absence, and an absence is what a broken
     * fixture, a failed query or a typo'd search token also produce. This is
     * the one that says the surfaces work at all.
     */
    const t = nextToken()
    const v = await viewer("dv_control")
    const id = await event(t)

    expect(await listedIds(v.token, t)).toContain(id)
    expect(await searchedIds(v.token, t)).toContain(id)
  })

  it.each([
    ["a draft", { status: "draft" as const }],
    ["a cancelled event", { status: "cancelled" as const }],
    ["a private event", { visibility: "private" as const }],
    ["an unlisted event", { visibility: "unlisted" as const }],
    ["a deleted event", { deleted: true }],
  ])("never shows %s, on either surface", async (_label, opts) => {
    const t = nextToken()
    const v = await viewer("dv_hidden")
    const id = await event(t, opts)

    // A published, public sibling under the same search term. Without it, an
    // empty result would satisfy every assertion below — including one caused
    // by a typo'd term or a broken query.
    const sibling = await event(t)

    const [listed, searched] = await Promise.all([
      listedIds(v.token, t),
      searchedIds(v.token, t),
    ])
    expect({ list: listed.includes(sibling), search: searched.includes(sibling) }).toEqual({
      list: true,
      search: true,
    })

    expect({
      inList: listed.includes(id),
      inSearch: searched.includes(id),
    }).toEqual({ inList: false, inSearch: false })
  })

  it("keeps an ended event out of the default list", async () => {
    /*
     * `includePast=true` is opt-in, because "my past events" is a real screen.
     * The default is what a phone opens on, and an event that finished last
     * night presented as something to go to is the failure.
     */
    const t = nextToken()
    const v = await viewer("dv_past")
    const id = await event(t, { endedHoursAgo: 5 })

    expect(await listedIds(v.token, t)).not.toContain(id)

    const res = await listRoute.GET(
      new NextRequest(
        `http://localhost/api/mobile/events?limit=100&includePast=true&search=${t}`,
        { headers: { authorization: `Bearer ${v.token}` } }
      )
    )
    const body = await res.json()
    const rows = Array.isArray(body.data) ? body.data : (body.data.events ?? [])
    expect(rows.map((e: { id: string }) => e.id)).toContain(id)
  })

  it("search has no past-event filter, unlike the list", async () => {
    /*
     * Recorded rather than fixed, because it is a product decision and not
     * obviously wrong: the list's own comment calls "search history" a real
     * screen, so search returning a finished event is defensible.
     *
     * What is not defensible is that the two surfaces answer differently with
     * no way to ask — the list takes `includePast`, search takes nothing and
     * always includes them. This test pins today's behaviour so the difference
     * is a decision somebody made rather than one nobody noticed.
     */
    const t = nextToken()
    const v = await viewer("dv_pastsearch")
    const id = await event(t, { endedHoursAgo: 5 })

    expect(await searchedIds(v.token, t)).toContain(id)
  })
})

describe("age is checked at the door, not in the feed", () => {
  const eighteenYears = () => new Date(Date.now() - 18 * 365.25 * 24 * HOUR)
  const fifteenYears = () => new Date(Date.now() - 15 * 365.25 * 24 * HOUR)

  it("shows an 18+ event to somebody whose age is unknown", async () => {
    /*
     * Permissive on purpose. Age lives on the profile and most people have not
     * set one; hiding every restricted event from all of them would empty the
     * feed. The refusal happens where it can explain itself.
     */
    const t = nextToken()
    const v = await viewer("dv_noage")
    const id = await event(t, { minAge: 18 })

    expect(await listedIds(v.token, t)).toContain(id)
    expect(await searchedIds(v.token, t)).toContain(id)
  })

  it("hides an 18+ event from somebody known to be under it", async () => {
    const t = nextToken()
    const v = await viewer("dv_minor", fifteenYears())
    const id = await event(t, { minAge: 18 })
    const open = await event(t)

    const [listed, searched] = await Promise.all([
      listedIds(v.token, t),
      searchedIds(v.token, t),
    ])
    // The control: an unrestricted event under the same term is still shown, so
    // the absence below is the age rule and not an empty query.
    expect({ list: listed.includes(open), search: searched.includes(open) }).toEqual({
      list: true,
      search: true,
    })
    expect({ inList: listed.includes(id), inSearch: searched.includes(id) }).toEqual({
      inList: false,
      inSearch: false,
    })
  })

  it("shows it to somebody old enough — or the test above proves nothing", async () => {
    const t = nextToken()
    const v = await viewer("dv_adult", eighteenYears())
    const id = await event(t, { minAge: 18 })

    expect(await listedIds(v.token, t)).toContain(id)
    expect(await searchedIds(v.token, t)).toContain(id)
  })

  it("refuses the unknown-age viewer at the door, and says what to fix", async () => {
    const t = nextToken()
    const v = await viewer("dv_door")
    const id = await event(t, { minAge: 18 })

    const res = await checkinRoute.POST(
      new NextRequest(`http://localhost/api/mobile/events/${id}/checkin`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${v.token}` },
        body: JSON.stringify({ latitude: LAT, longitude: LNG }),
      }),
      { params: Promise.resolve({ eventId: id }) }
    )

    expect(res.status).toBeGreaterThanOrEqual(400)
    const body = await res.json()
    // The copy matters: "18+" alone leaves them with no move. The refusal has
    // to name the thing they can change.
    expect(JSON.stringify(body)).toMatch(/Add your age to your profile/)
  })
})
