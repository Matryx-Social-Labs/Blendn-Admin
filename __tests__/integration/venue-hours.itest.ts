const mockGetAuth = jest.fn()
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/auth", () => ({ getAuth: async () => { const s = await mockGetAuth(); return s?.user ? { ...s, user: { signedInAt: Date.now(), ...s.user } } : s } }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { NextRequest } from "next/server"

import { signAccessToken } from "@/lib/mobile-auth"
import { resetMemoryStore } from "@/lib/rate-limit-store"
import { setVenueHours } from "@/lib/venue-actions"
import { closeDb, db, makeEvent, makeUser, onboard, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const detail = require("@/app/api/mobile/venues/[venueId]/route") as typeof import("@/app/api/mobile/venues/[venueId]/route")
/* eslint-enable @typescript-eslint/no-require-imports */

/*
 * SCRUM-1154: `venues.hours` had no writer. The venue's owning organisation
 * (any active member, as for its amenities) or an admin sets it from the venue
 * page; the row and its `venue.hours_updated` audit entry, with the hours
 * before and after, commit together. Everyone else is refused by the action
 * itself, and writes nothing.
 */
const users: string[] = []
const orgs: string[] = []
const venues: string[] = []
const events: string[] = []

const WEEK = [
  { day: 2, open: "17:00", close: "23:00" },
  { day: 5, open: "18:00", close: "01:30" },
  { day: 6, open: "18:00", close: "02:00" },
]

afterAll(async () => {
  await db.audit_logs.deleteMany({ where: { resource_id: { in: venues } } })
  await db.events.deleteMany({ where: { id: { in: events } } })
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await db.profiles.deleteMany({ where: { id: { in: users } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
}, 60_000)
beforeEach(() => resetMemoryStore())

async function person(label: string, role: "venue_owner" | "organizer" | "app_admin", memberRole: "owner" | "admin" | "staff" = "owner", orgId?: string) {
  const id = await makeUser(testId(label), role === "venue_owner" ? "organizer" : role)
  users.push(id)
  if (role === "venue_owner") await db.user.update({ where: { id }, data: { role } })
  let org = orgId
  if (!org) {
    org = (await db.organisations.create({ data: { kind: "company", display_name: testId(`${label}-org`), status: "verified" } })).id
    orgs.push(org)
  }
  await db.organisation_members.create({ data: { org_id: org, user_id: id, role: memberRole } })
  return { id, orgId: org, as: () => mockGetAuth.mockResolvedValue({ user: { id, role } }) }
}

async function venue(data: { owner_org_id?: string; created_by_org_id?: string; deleted_at?: Date } = {}) {
  const v = await db.venues.create({
    data: {
      name: testId("Hours Hall"),
      latitude: 12.97,
      longitude: 77.59,
      timezone: "Asia/Kolkata",
      day_reset_hour: 6,
      ...(data.owner_org_id ? { owner_org_id: data.owner_org_id, claimed_at: new Date() } : {}),
      ...(data.created_by_org_id ? { created_by_org_id: data.created_by_org_id } : {}),
      ...(data.deleted_at ? { deleted_at: data.deleted_at } : {}),
    },
  })
  venues.push(v.id)
  return v.id
}

const hoursOf = async (id: string) => (await db.venues.findUniqueOrThrow({ where: { id }, select: { hours: true } })).hours
const auditsOf = (id: string) =>
  db.audit_logs.findMany({ where: { resource_id: id, action: "venue.hours_updated" }, orderBy: { created_at: "asc" } })

describe("setVenueHours: who may write", () => {
  it("lets the owner's organisation save the week: the Json as given, by day, and one audit row with before and after", async () => {
    const owner = await person("vh-owner", "venue_owner")
    const v = await venue({ owner_org_id: owner.orgId })
    owner.as()
    await setVenueHours(v, [WEEK[2], WEEK[0], WEEK[1]])

    expect(await hoursOf(v)).toEqual(WEEK)
    const audits = await auditsOf(v)
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ user_id: owner.id, resource: "venue", org_id: owner.orgId })
    expect(audits[0].details).toEqual({ before: null, after: WEEK })
  })

  it("lets a staff member of the owning organisation and an admin save", async () => {
    const owner = await person("vh-owner2", "venue_owner")
    const staff = await person("vh-staff", "venue_owner", "staff", owner.orgId)
    const admin = await person("vh-admin", "app_admin")
    const v = await venue({ owner_org_id: owner.orgId })
    staff.as()
    await setVenueHours(v, [WEEK[0]])
    expect(await hoursOf(v)).toEqual([WEEK[0]])
    admin.as()
    await setVenueHours(v, WEEK)
    expect(await hoursOf(v)).toEqual(WEEK)
    expect((await auditsOf(v)).map((a) => a.user_id)).toEqual([staff.id, admin.id])
  })

  it("refuses everyone else, by the action, and writes nothing", async () => {
    const owner = await person("vh-owner3", "venue_owner")
    const stranger = await person("vh-stranger", "venue_owner")
    const host = await person("vh-host", "organizer")
    const adder = await person("vh-adder", "organizer")
    const suspended = await person("vh-suspended", "venue_owner")
    const owned = await venue({ owner_org_id: owner.orgId })
    const unclaimed = await venue({ created_by_org_id: adder.orgId })
    const suspendedVenue = await venue({ owner_org_id: suspended.orgId })
    await db.organisations.update({ where: { id: suspended.orgId }, data: { status: "suspended" } })
    const retired = await venue({ owner_org_id: owner.orgId, deleted_at: new Date() })
    // The organizer ran a night there: that is not the venue's organisation.
    const night = await makeEvent(host.id)
    events.push(night)
    await db.events.update({ where: { id: night }, data: { venue_id: owned, organizer_org_id: host.orgId } })

    stranger.as()
    await expect(setVenueHours(owned, WEEK)).rejects.toThrow(/Forbidden/)
    host.as()
    await expect(setVenueHours(owned, WEEK)).rejects.toThrow(/Forbidden/)
    // A venue day is an event, not a venue: its id is no venue's.
    await expect(setVenueHours(night, WEEK)).rejects.toThrow(/not found/)
    adder.as()
    await expect(setVenueHours(unclaimed, WEEK)).rejects.toThrow(/owner|admin/i)
    suspended.as()
    await expect(setVenueHours(suspendedVenue, WEEK)).rejects.toThrow(/Forbidden/)
    owner.as()
    await expect(setVenueHours(retired, WEEK)).rejects.toThrow(/not found/)
    mockGetAuth.mockResolvedValue(null)
    await expect(setVenueHours(owned, WEEK)).rejects.toThrow(/Unauthorized/)

    for (const id of [owned, unclaimed, suspendedVenue, retired]) {
      expect(await hoursOf(id)).toBeNull()
      expect(await auditsOf(id)).toHaveLength(0)
    }
  })
})

describe("setVenueHours: what it accepts", () => {
  it("refuses what the readers would show wrong, and anything not the shape, and writes nothing", async () => {
    const owner = await person("vh-owner4", "venue_owner")
    const v = await venue({ owner_org_id: owner.orgId })
    owner.as()
    await setVenueHours(v, WEEK)
    const refusals: [unknown, RegExp][] = [
      [[{ day: 6, open: "12:00", close: "15:00" }, { day: 6, open: "19:00", close: "02:00" }], /Saturday/],
      [[{ day: 5, open: "18:00", close: "07:00" }], /Friday.*Saturday/],
      [[{ day: 6, open: "05:00", close: "11:00" }], /06:00/],
      [[{ day: 0, open: "22:00", close: "22:00" }], /Sunday/],
      [[{ day: 5, open: "18:00", close: "24:00" }], /hours/i],
      [[{ day: 7, open: "18:00", close: "23:00" }], /hours/i],
      [[{ day: 5, open: "18:00", close: "23:00", note: "x" }], /hours/i],
      [null, /hours/i],
      ["Fri 6pm", /hours/i],
    ]
    for (const [rows, message] of refusals) await expect(setVenueHours(v, rows)).rejects.toThrow(message)
    expect(await hoursOf(v)).toEqual(WEEK)
    expect(await auditsOf(v)).toHaveLength(1)
  })

  it("saves an empty week as NULL (not given), and a save that changes nothing writes no row", async () => {
    const owner = await person("vh-owner5", "venue_owner")
    const v = await venue({ owner_org_id: owner.orgId })
    owner.as()
    await setVenueHours(v, WEEK)
    await setVenueHours(v, [...WEEK].reverse())
    expect(await auditsOf(v)).toHaveLength(1)
    await setVenueHours(v, [])
    const [{ hours_is_null }] = await db.$queryRaw<{ hours_is_null: boolean }[]>`SELECT hours IS NULL AS hours_is_null FROM venues WHERE id = ${v}::uuid`
    expect(hours_is_null).toBe(true)
    const audits = await auditsOf(v)
    expect(audits).toHaveLength(2)
    expect(audits[1].details).toEqual({ before: WEEK, after: null })
  })

  it("keeps both of two saves at once in the record: the last write wins, and each audit row's before is the other's after", async () => {
    const owner = await person("vh-owner6", "venue_owner")
    const v = await venue({ owner_org_id: owner.orgId })
    owner.as()
    const a = [WEEK[0]]
    const b = [WEEK[1]]
    await Promise.all([setVenueHours(v, a), setVenueHours(v, b)])
    const audits = await auditsOf(v)
    expect(audits).toHaveLength(2)
    const [first, second] = [audits[0].details as { before: unknown; after: unknown }, audits[1].details as { before: unknown; after: unknown }]
    expect(first.before).toBeNull()
    expect(second.before).toEqual(first.after)
    expect([first.after, second.after]).toEqual(expect.arrayContaining([a, b]))
    expect(await hoursOf(v)).toEqual(second.after)
  })
})

describe("GET /venues/:id returns what was saved", () => {
  it("carries the saved week as hours, with the zone and reset it is read in", async () => {
    const owner = await person("vh-owner7", "venue_owner")
    const v = await venue({ owner_org_id: owner.orgId })
    owner.as()
    await setVenueHours(v, WEEK)

    const viewerId = await makeUser(testId("vh-viewer"))
    users.push(viewerId)
    await onboard(viewerId)
    await db.profiles.update({ where: { id: viewerId }, data: { age: 30 } })
    const res = await detail.GET(
      new NextRequest(`http://localhost/api/mobile/venues/${v}`, { headers: { authorization: `Bearer ${signAccessToken(viewerId, `${viewerId}@itest.invalid`)}` } }),
      { params: Promise.resolve({ venueId: v }) }
    )
    expect(res.status).toBe(200)
    const { data } = await res.json()
    expect(data.venue).toMatchObject({ hours: WEEK, timezone: "Asia/Kolkata", dayResetHour: 6 })
  })
})
