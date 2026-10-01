let session: { user: { id: string; role: string } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: () => Promise.resolve(session) }))

import { NextRequest } from "next/server"
import { attendeeLabel } from "@/lib/pseudonym"
import { pseudonymScope } from "@/lib/reports"
import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, testId } from "./helpers"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventsRoute = require("@/app/api/events/route") as typeof import("@/app/api/events/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const reportRoute = require("@/app/api/reports/[key]/route") as typeof import("@/app/api/reports/[key]/route")

/*
 * F4 / F5 of the analytics audit: a claim opens a venue from the claim on.
 *
 * Owner's ruling (2026-09-27, SCRUM-355): an approved claim gives the owner no
 * operational access to events held at the venue before it. `eventPermissions`
 * honoured that; the venue owner's event list and the CSV exports did not —
 * they scoped on `venue.owner_org_id` alone, so the check-ins report handed a
 * new owner one row per guest, by label and to the second, for nights nobody
 * at the venue agreed to show them.
 *
 * And the venue owner's check-ins export is aggregate whatever the date: per
 * event per day, a count, held back under the minimum cell. A label is a
 * person. The organiser's own export is unchanged.
 *
 * Driven through the routes a person actually calls — the events list and the
 * CSV download — against a real Postgres.
 */
const users: string[] = []
const orgs: string[] = []
const events: string[] = []
const venues: string[] = []
const DAY = 86_400_000
const HOUR = 3_600_000

afterAll(async () => {
  await db.events.updateMany({ where: { id: { in: events } }, data: { venue_id: null } })
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await cleanup(users, events)
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await closeDb()
})

async function org(label: string, member: string) {
  const o = await db.organisations.create({
    data: { kind: "company", display_name: testId(label), status: "verified" },
  })
  orgs.push(o.id)
  await db.organisation_members.create({ data: { org_id: o.id, user_id: member, role: "owner" } })
  return o.id
}

async function guests(n: number, label: string) {
  const ids: string[] = []
  for (let i = 0; i < n; i++) ids.push(await makeUser(`${label}-${i}`))
  users.push(...ids)
  return ids
}

let w: {
  host: string
  owner: string
  before: string
  after: string
  small: string
  beforeGuests: string[]
  afterGuests: string[]
}

beforeAll(async () => {
  const host = await makeUser("vosc-host", "organizer")
  const owner = await makeUser("vosc-owner", "organizer")
  users.push(host, owner)
  await db.user.update({ where: { id: owner }, data: { role: "venue_owner" } })
  const hostOrg = await org("vosc-host-org", host)
  const venueOrg = await org("vosc-venue-org", owner)

  const claimedAt = new Date(Date.now() - 2 * DAY)
  const venue = await db.venues.create({
    data: { name: testId("vosc-venue"), latitude: 12.9, longitude: 77.5, owner_org_id: venueOrg, claimed_at: claimedAt },
    select: { id: true },
  })
  venues.push(venue.id)

  const at = async (start: Date, people: string[]) => {
    const id = await makeEvent(host)
    events.push(id)
    await db.events.update({
      where: { id },
      data: { venue_id: venue.id, organizer_org_id: hostOrg, start_time: start, end_time: new Date(start.getTime() + 3 * HOUR) },
    })
    const occurrence = await occurrenceOf(id)
    await db.event_occurrences.update({
      where: { id: occurrence },
      data: { occurs_on: new Date(start.toISOString().slice(0, 10)), start_time: start, end_time: new Date(start.getTime() + 3 * HOUR) },
    })
    for (const user_id of people) {
      await db.event_check_ins.create({
        data: { event_id: id, occurrence_id: occurrence, user_id, status: "checked_in", check_in_time: new Date(start.getTime() + HOUR) },
      })
    }
    return id
  }

  const beforeGuests = await guests(6, "vosc-b")
  const afterGuests = await guests(6, "vosc-a")
  w = {
    host,
    owner,
    beforeGuests,
    afterGuests,
    before: await at(new Date(claimedAt.getTime() - 5 * DAY), beforeGuests),
    after: await at(new Date(Date.now() - DAY), afterGuests),
    // Two guests: under the minimum cell.
    small: await at(new Date(Date.now() - DAY / 2), await guests(2, "vosc-s")),
  }
})

const as = (id: string, role: string) => {
  session = { user: { id, role } }
}

async function listed(): Promise<string[]> {
  const res = await eventsRoute.GET(new NextRequest("http://localhost/api/events"))
  expect(res.status).toBe(200)
  return ((await res.json()) as Array<{ id: string }>).map((e) => e.id)
}

async function csv(key: string): Promise<string> {
  const from = new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10)
  const to = new Date(Date.now() + DAY).toISOString().slice(0, 10)
  const res = await reportRoute.GET(
    new NextRequest(`http://localhost/api/reports/${key}?range=custom&from=${from}&to=${to}`),
    { params: Promise.resolve({ key }) }
  )
  expect(res.status).toBe(200)
  return res.text()
}

describe("a venue owner's list and exports start at the claim (F4)", () => {
  beforeEach(() => as(w.owner, "venue_owner"))

  it("lists the event after the claim and not the one before it", async () => {
    const ids = await listed()
    expect(ids).toContain(w.after)
    expect(ids).not.toContain(w.before)
  })

  it("leaves the event before the claim out of the events export", async () => {
    const out = await csv("events")
    expect(out).toContain(w.after)
    expect(out).not.toContain(w.before)
  })

  it("leaves the event before the claim out of the check-ins export", async () => {
    const out = await csv("check-ins")
    expect(out).toContain(w.after)
    expect(out).not.toContain(w.before)
  })
})

describe("a venue owner's check-ins export is counts, never people (F5)", () => {
  beforeEach(() => as(w.owner, "venue_owner"))

  it("carries no attendee label, and one row per event per day with its guests", async () => {
    const out = await csv("check-ins")
    const labels = await pseudonymScope("venue_owner", w.owner)
    for (const g of w.afterGuests) expect(out).not.toContain(attendeeLabel(g, labels))
    expect(out.split("\r\n")[0]).not.toMatch(/Attendee/)

    const rows = out.split("\r\n").filter((line) => line.includes(w.after))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatch(/,6$/)
  })

  it("holds back a day under the minimum cell rather than printing its count", async () => {
    const row = (await csv("check-ins")).split("\r\n").find((line) => line.includes(w.small))
    expect(row).toBeDefined()
    expect(row).toMatch(/,$/)
  })
})

describe("the organiser's own list and exports are unchanged", () => {
  beforeEach(() => as(w.host, "organizer"))

  it("lists both events, before and after the venue was claimed", async () => {
    const ids = await listed()
    expect(ids).toEqual(expect.arrayContaining([w.before, w.after]))
  })

  it("exports one check-in row per guest, by label, for their own event", async () => {
    const out = await csv("check-ins")
    const labels = await pseudonymScope("organizer", w.host)
    expect(out.split("\r\n")[0]).toMatch(/Attendee/)
    for (const g of w.beforeGuests) expect(out).toContain(attendeeLabel(g, labels))
    expect(out.split("\r\n").filter((line) => line.includes(w.before))).toHaveLength(6)
  })
})
