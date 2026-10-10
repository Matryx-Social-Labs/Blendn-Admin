process.env.MOBILE_JWT_SECRET =
  process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

// `jose` is ESM-only; see checkin.itest.ts.
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/tigris", () => ({ deletePrefix: jest.fn().mockResolvedValue(0) }))
const mockGetAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: () => mockGetAuth() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { setVenueOpenOnBlendn } from "@/lib/venue-actions"

import { closeDb, db, makeUser, testId } from "./helpers"
import { cleanupWorld, person, realEvent, req, venue, world } from "./go-live-world"

/* eslint-disable @typescript-eslint/no-require-imports */
const venuesRoute = require("@/app/api/mobile/venues/route") as typeof import("@/app/api/mobile/venues/route")
const eventsRoute = require("@/app/api/mobile/events/route") as typeof import("@/app/api/mobile/events/route")
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * "Open on Blendn" (D-13, PL-E04) against real Postgres: a claimed venue's
 * owner takes it out of the app's Places and home map (both read
 * `GET /venues`), the column and an audit row are written together, its
 * events still show, and an unclaimed venue is always listed.
 */

const TOKEN = `zob${Date.now().toString(36).replace(/\d/g, "")}q`

let ownerUser = ""
let ownerOrg = ""
let otherUser = ""
let creatorUser = ""
let creatorOrg = ""
let admin = ""
let viewer = { id: "", token: "" }

async function org(label: string, userId: string) {
  const o = await db.organisations.create({ data: { kind: "company", display_name: testId(label), status: "verified" } })
  world.orgs.push(o.id)
  await db.organisation_members.create({ data: { org_id: o.id, user_id: userId, role: "owner" } })
  return o.id
}

const as = (id: string, role: string) => mockGetAuth.mockResolvedValue({ user: { id, role } })
const openOf = async (id: string) =>
  (await db.venues.findUniqueOrThrow({ where: { id }, select: { open_on_blendn: true } })).open_on_blendn
const auditFor = (id: string) =>
  db.audit_logs.findMany({ where: { resource: "venue", resource_id: id, action: { contains: "on_blendn" } }, orderBy: { created_at: "asc" } })

/** A named venue, so a search for this suite's token finds exactly ours. */
async function named(label: string, opts: { ownerOrg?: string } = {}) {
  const id = await venue(opts)
  await db.venues.update({ where: { id }, data: { name: `${TOKEN} ${label}` } })
  return id
}

async function listedIds() {
  // `search` sets the route's own `OR`: listing under it proves the opt-out
  // sits under `AND` rather than being replaced by the search (F4).
  const res = await venuesRoute.GET(req(`/api/mobile/venues?search=${TOKEN}&limit=50`, viewer.token))
  expect(res.status).toBe(200)
  return ((await res.json()).data.venues as { id: string }[]).map((v) => v.id)
}

beforeAll(async () => {
  ownerUser = await makeUser(testId("ob_owner"), "organizer")
  otherUser = await makeUser(testId("ob_other"), "organizer")
  creatorUser = await makeUser(testId("ob_creator"), "organizer")
  admin = await makeUser(testId("ob_admin"), "app_admin")
  world.users.push(ownerUser, otherUser, creatorUser, admin)
  await db.user.updateMany({ where: { id: { in: [ownerUser, otherUser] } }, data: { role: "venue_owner" } })
  ownerOrg = await org("ob-org", ownerUser)
  await org("ob-other-org", otherUser)
  creatorOrg = await org("ob-creator-org", creatorUser)
  viewer = await person("ob_viewer")
})

afterAll(async () => {
  await db.audit_logs.deleteMany({ where: { resource: "venue", resource_id: { in: world.venues } } })
  await db.event_rsvps.deleteMany({ where: { event: { venue_id: { in: world.venues } } } })
  await cleanupWorld()
  await closeDb()
}, 120_000)

describe("the owner switches a claimed venue off", () => {
  it("writes the column and one audit row, and the venue leaves GET /venues while its events still show", async () => {
    const id = await named("closing", { ownerOrg })
    const control = await named("staying", { ownerOrg })
    const night = await realEvent(id, { startsInMin: 3 * 24 * 60, link: "confirmed" })
    const title = (await db.events.findUniqueOrThrow({ where: { id: night }, select: { title: true } })).title
    expect(await listedIds()).toEqual(expect.arrayContaining([id, control]))

    as(ownerUser, "venue_owner")
    await setVenueOpenOnBlendn(id, false)

    expect(await openOf(id)).toBe(false)
    const audit = await auditFor(id)
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({
      user_id: ownerUser,
      action: "venue.closed_on_blendn",
      details: { open_on_blendn: false },
    })

    const listed = await listedIds()
    expect(listed).not.toContain(id)
    // The control: the same owner's other venue is still there.
    expect(listed).toContain(control)

    // Its events still show, by the event feed's own search.
    const events = await eventsRoute.GET(req(`/api/mobile/events?search=${encodeURIComponent(title)}&limit=50`, viewer.token))
    expect(events.status).toBe(200)
    const eventIds = ((await events.json()).data.events as { id: string }[]).map((e) => e.id)
    expect(eventIds).toContain(night)
  })

  it("comes back when switched on, and setting what is already set writes nothing", async () => {
    const id = await named("returning", { ownerOrg })
    as(ownerUser, "venue_owner")
    await setVenueOpenOnBlendn(id, false)
    await setVenueOpenOnBlendn(id, false)
    expect((await auditFor(id)).map((a) => a.action)).toEqual(["venue.closed_on_blendn"])

    await setVenueOpenOnBlendn(id, true)
    await setVenueOpenOnBlendn(id, true)
    expect(await openOf(id)).toBe(true)
    expect((await auditFor(id)).map((a) => a.action)).toEqual(["venue.closed_on_blendn", "venue.opened_on_blendn"])
    expect(await listedIds()).toContain(id)
  })

  it("may be done by an admin", async () => {
    const id = await named("admin-closed", { ownerOrg })
    as(admin, "app_admin")
    await setVenueOpenOnBlendn(id, false)
    expect(await openOf(id)).toBe(false)
    expect((await auditFor(id))[0]).toMatchObject({ user_id: admin, action: "venue.closed_on_blendn" })
  })
})

describe("an unclaimed venue is always listed", () => {
  it("whatever its column says, so a claim taken back never leaves a place hidden that nobody owns", async () => {
    const id = await named("orphaned", { ownerOrg })
    as(ownerUser, "venue_owner")
    await setVenueOpenOnBlendn(id, false)
    expect(await listedIds()).not.toContain(id)

    // The claim is revoked; the column is left as it was.
    await db.venues.update({ where: { id }, data: { owner_org_id: null, claimed_at: null } })
    expect(await openOf(id)).toBe(false)
    expect(await listedIds()).toContain(id)
  })

  it("cannot be switched off, by an admin or by the organisation that added it", async () => {
    const id = await named("unclaimed")
    await db.venues.update({ where: { id }, data: { created_by_org_id: creatorOrg } })

    as(admin, "app_admin")
    await expect(setVenueOpenOnBlendn(id, false)).rejects.toThrow("Only a claimed venue can leave the app's Places")
    as(creatorUser, "organizer")
    await expect(setVenueOpenOnBlendn(id, false)).rejects.toThrow("Only a claimed venue can leave the app's Places")

    expect(await openOf(id)).toBe(true)
    expect(await auditFor(id)).toHaveLength(0)
  })
})

describe("who may switch it", () => {
  it("refuses another organisation's venue owner, and writes nothing", async () => {
    const id = await named("not-theirs", { ownerOrg })
    as(otherUser, "venue_owner")
    await expect(setVenueOpenOnBlendn(id, false)).rejects.toThrow("Forbidden")
    expect(await openOf(id)).toBe(true)
    expect(await auditFor(id)).toHaveLength(0)
  })

  it("reads the role from the database, not the session's claim", async () => {
    const id = await named("claimed-admin", { ownerOrg })
    // The cookie says app_admin; the row says organizer, with no membership.
    as(creatorUser, "app_admin")
    await expect(setVenueOpenOnBlendn(id, false)).rejects.toThrow("Forbidden")
    expect(await openOf(id)).toBe(true)
    expect(await auditFor(id)).toHaveLength(0)
  })

  it("refuses a suspended owner, and anything but a boolean", async () => {
    const id = await named("suspended", { ownerOrg })
    as(ownerUser, "venue_owner")
    await expect(setVenueOpenOnBlendn(id, "off" as unknown as boolean)).rejects.toThrow("Open on Blendn is on or off.")

    await db.user.update({ where: { id: ownerUser }, data: { suspended_at: new Date() } })
    try {
      await expect(setVenueOpenOnBlendn(id, false)).rejects.toThrow("Unauthorized")
    } finally {
      await db.user.update({ where: { id: ownerUser }, data: { suspended_at: null } })
    }
    expect(await openOf(id)).toBe(true)
    expect(await auditFor(id)).toHaveLength(0)
  })
})
