/*
 * D-030 (SCRUM-1384): before a reveal a person's row carries a wide age band — only when 3+ people who checked in at
 * that event share it — and a new / regular chip. No exact age, no city, no join date, no counts. Hosts get none of
 * it. Through the real routes on a db:migrate database, then the attendance read back with SQL.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
process.env.NEXTAUTH_SECRET ??= "itest-room-facts-secret-32-characters-xx"
process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"

import { Prisma } from "@prisma/client"

import { ATTENDED } from "@/lib/counting"
import { roomHandle } from "@/lib/room-handle"

import { db, makeEvent, occurrenceOf, testId } from "./helpers"
import { arrive, call, cleanupCrewWorld, crewOf, liveEvent, person, world, type Person } from "./crew-world"

/* eslint-disable @typescript-eslint/no-require-imports */
const usersRoute = require("@/app/api/mobile/users/[userId]/route") as typeof import("@/app/api/mobile/users/[userId]/route")
const profilesRoute = require("@/app/api/mobile/profiles/[userId]/route") as typeof import("@/app/api/mobile/profiles/[userId]/route")
const matchesRoute = require("@/app/api/mobile/events/[eventId]/matches/route") as typeof import("@/app/api/mobile/events/[eventId]/matches/route")
const peopleRoute = require("@/app/api/mobile/events/[eventId]/people/route") as typeof import("@/app/api/mobile/events/[eventId]/people/route")
const checkinsRoute = require("@/app/api/mobile/events/[eventId]/checkins/route") as typeof import("@/app/api/mobile/events/[eventId]/checkins/route")
const previewRoute = require("@/app/api/mobile/me/preview/route") as typeof import("@/app/api/mobile/me/preview/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const orgs: string[] = []
afterAll(async () => {
  await db.event_match_preferences.deleteMany({ where: { user_id: { in: world.users } } })
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await db.events.updateMany({ where: { id: { in: world.events } }, data: { organizer_org_id: null } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await cleanupCrewWorld()
})

/** Born so that they are `years` old at an event that started an hour ago, a month clear of a birthday. */
const bornYearsAgo = (years: number) => new Date(Date.now() - (years * 365.25 + 30) * 86_400_000)

async function aged(label: string, years: number | null): Promise<Person> {
  const p = await person(label)
  await db.profiles.update({
    where: { id: p.id },
    data: { age: null, date_of_birth: years === null ? null : bornYearsAgo(years), location: "Bengaluru" },
  })
  return p
}

let eventId = ""
let occurrenceId = ""
let host: Person, viewer: Person, a: Person, b: Person, c: Person, d: Person

beforeAll(async () => {
  ;[host, viewer, a, b, c, d] = [
    await aged("rpf-host", null), // no age: never in a band's count
    await aged("rpf-viewer", 50), // alone in 45+
    await aged("rpf-a", 26),
    await aged("rpf-b", 28),
    await aged("rpf-c", 30),
    await aged("rpf-d", 41), // alone in 35-44
  ]
  ;({ eventId, occurrenceId } = await liveEvent(host.id))
  // The host's organisation runs the event: they operate it (`eventPermissions(...).canOperate`).
  const org = await db.organisations.create({ data: { display_name: testId("rpf-org"), kind: "company", status: "verified" } })
  orgs.push(org.id)
  await db.organisation_members.create({ data: { org_id: org.id, user_id: host.id, role: "owner" } })
  await db.events.update({ where: { id: eventId }, data: { organizer_org_id: org.id } })

  // A came to one earlier event too: two events, a regular.
  const earlier = await makeEvent(host.id)
  world.events.push(earlier)
  await db.event_check_ins.create({
    data: {
      event_id: earlier,
      occurrence_id: await occurrenceOf(earlier),
      user_id: a.id,
      kind: "attendee",
      status: "checked_out",
      check_in_time: new Date(Date.now() - 50 * 3_600_000),
    },
  })
  // C came on another day of THIS event as well: one event over two days, still new.
  const otherDay = await db.event_occurrences.create({
    data: { event_id: eventId, occurs_on: new Date(Date.now() - 86_400_000), start_time: new Date(Date.now() - 86_400_000), end_time: new Date(Date.now() - 80_000_000) },
  })
  await db.event_check_ins.create({
    data: { event_id: eventId, occurrence_id: otherDay.id, user_id: c.id, kind: "attendee", status: "checked_out", check_in_time: new Date(Date.now() - 85_000_000) },
  })

  for (const p of [viewer, a, b, d, host]) await arrive(eventId, occurrenceId, p)
  // B chose "show who I am" here.
  await db.event_match_preferences.create({ data: { event_id: eventId, user_id: b.id, revealed: true } })
})

const h = (p: Person) => roomHandle(eventId, p.id)
const get = (route: unknown, path: string, as: Person, params: Record<string, string>) => call(route, path, as, { params })
const card = (ref: string, as: Person) => get(usersRoute.GET, `/api/mobile/users/${ref}`, as, { userId: ref })
const profile = (ref: string, as: Person) => get(profilesRoute.GET, `/api/mobile/profiles/${ref}`, as, { userId: ref })
async function rows(as: Person): Promise<Map<string, Record<string, unknown>>> {
  const res = await get(matchesRoute.GET, `/api/mobile/events/${eventId}/matches`, as, { eventId })
  expect(res.status).toBe(200)
  const list = (res.body.data.matches ?? res.body.data) as Record<string, unknown>[]
  return new Map(list.map((r) => [r.userId as string, r]))
}

describe("the band waits for a third person in it", () => {
  it("is null for A and B while only two 25-34s have checked in", async () => {
    const before = await rows(viewer)
    expect(before.get(h(a))).toMatchObject({ age: null, ageBand: null })
    expect((await card(h(a), viewer)).body.data).toMatchObject({ age: null, ageBand: null })
  })

  it("shows 25-34 on every row in it once C checks in", async () => {
    await arrive(eventId, occurrenceId, c)
    const after = await rows(viewer)
    expect(after.get(h(a))).toMatchObject({ age: null, ageBand: "25-34" })
    expect(after.get(h(c))).toMatchObject({ age: null, ageBand: "25-34" })
  })
})

describe("GET /events/:id/matches — the roster the app reads", () => {
  it("sends an unrevealed row the band and the chip, never the age", async () => {
    const r = await rows(viewer)
    expect(r.get(h(a))).toMatchObject({ revealed: false, age: null, ageBand: "25-34", tenure: "regular" })
    expect(r.get(h(c))).toMatchObject({ age: null, ageBand: "25-34", tenure: "new" })
    // Alone in 35-44: no band, so the room cannot single the one 41-year-old out.
    expect(r.get(h(d))).toMatchObject({ age: null, ageBand: null, tenure: "new" })
  })

  it("keeps a revealed person's exact age", async () => {
    expect((await rows(viewer)).get(h(b))).toMatchObject({ revealed: true, age: 28, ageBand: "25-34" })
  })

  it("gives a host none of it: totals only", async () => {
    const r = await rows(host)
    for (const p of [a, b, c, d]) expect(r.get(h(p))).toMatchObject({ age: null, ageBand: null, tenure: null })
  })
})

describe("GET /events/:id/people and /checkins", () => {
  it("people: the same band and chip, no age", async () => {
    const res = await get(peopleRoute.GET, `/api/mobile/events/${eventId}/people`, viewer, { eventId })
    const byId = new Map((res.body.data.people as Record<string, unknown>[]).map((p) => [p.userId, p]))
    expect(byId.get(h(a))).toMatchObject({ age: null, ageBand: "25-34", tenure: "regular" })
    expect(byId.get(h(d))).toMatchObject({ age: null, ageBand: null, tenure: "new" })
  })

  it("checkins: no age and no city before a reveal", async () => {
    const res = await get(checkinsRoute.GET, `/api/mobile/events/${eventId}/checkins`, viewer, { eventId })
    const byId = new Map((res.body.data.attendees as Record<string, unknown>[]).map((p) => [p.userId, p]))
    expect(byId.get(h(a))).toMatchObject({ age: null, location: null, ageBand: "25-34", tenure: "regular" })
    expect(byId.get(h(b))).toMatchObject({ age: 28, location: "Bengaluru" })
  })
})

describe("the card a row opens", () => {
  it("users/:handle — band and chip; no age, city, join date or counts", async () => {
    const body = (await card(h(d), viewer)).body.data
    expect(body).toMatchObject({ identityVisible: false, age: null, location: null, ageBand: null, tenure: "new" })
    expect(body).not.toHaveProperty("memberSince")
    expect(body).not.toHaveProperty("stats")
    expect((await card(h(a), viewer)).body.data).toMatchObject({ ageBand: "25-34", tenure: "regular" })
  })

  it("profiles/:handle — the same, under `profile`", async () => {
    const body = (await profile(h(a), viewer)).body.data
    expect(body.profile).toMatchObject({ age: null, location: null, ageBand: "25-34", tenure: "regular" })
    expect(body).not.toHaveProperty("createdAt")
  })

  it("a raw id the viewer may not name: no age, city, date, counts, band or chip", async () => {
    const byUsers = (await card(d.id, viewer)).body.data
    expect(byUsers).toMatchObject({ identityVisible: false, age: null, location: null, ageBand: null, tenure: null })
    expect(byUsers).not.toHaveProperty("memberSince")
    expect(byUsers).not.toHaveProperty("stats")
    const byProfiles = (await profile(d.id, viewer)).body.data
    expect(byProfiles.profile).toMatchObject({ age: null, location: null, ageBand: null, tenure: null })
    expect(byProfiles).not.toHaveProperty("createdAt")
  })

  it("a revealed person's card keeps the exact age", async () => {
    expect((await card(h(b), viewer)).body.data).toMatchObject({ identityVisible: true, age: 28 })
  })

  it("a host's card: no band, no chip", async () => {
    expect((await card(h(a), host)).body.data).toMatchObject({ age: null, location: null, ageBand: null, tenure: null })
  })

  it("a crew's card: the chip, never a band (no event to count over)", async () => {
    const [owner, mate] = [await aged("rpf-crew1", 27), await aged("rpf-crew2", 27)]
    const crew = await crewOf(owner, [mate])
    const ref = roomHandle({ kind: "crew", groupId: crew.roomId }, mate.id)
    expect((await card(ref, owner)).body.data).toMatchObject({ age: null, location: null, ageBand: null, tenure: "new" })
  })
})

describe("GET /me/preview", () => {
  it("shows you the band and chip the room shows, not your age or city", async () => {
    const res = await call(previewRoute.GET, "/api/mobile/me/preview", a)
    expect(res.body.data.anonymous).toMatchObject({ age: null, location: null, ageBand: "25-34", tenure: "regular" })
  })
})

describe("read back", () => {
  it("tenure is what event_check_ins says: regular at 2+ distinct events", async () => {
    const ids = [a.id, b.id, c.id, d.id]
    const counted = await db.$queryRaw<{ user_id: string; events: number }[]>`
      SELECT user_id, count(DISTINCT event_id)::int AS events
        FROM event_check_ins
       WHERE status::text IN (${Prisma.join(ATTENDED)}) AND kind = 'attendee' AND user_id = ANY(${ids}::text[])
       GROUP BY 1`
    const r = await rows(viewer)
    const label = new Map([[a.id, "A"], [b.id, "B"], [c.id, "C"], [d.id, "D"]])
    // The drive's record, in the step log.
    console.log(`[read-back] ${counted.map((x) => `${label.get(x.user_id)}=${x.events}→${r.get(h({ id: x.user_id } as Person))?.tenure}`).join(" ")}`)
    for (const x of counted) expect(r.get(h({ id: x.user_id } as Person))?.tenure).toBe(x.events >= 2 ? "regular" : "new")
    expect(counted).toHaveLength(4)
  })
})
