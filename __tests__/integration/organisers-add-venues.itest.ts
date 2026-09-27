const mockGetAuth = jest.fn()
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/auth", () => ({ getAuth: () => mockGetAuth() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { createVenue, updateVenue } from "@/lib/venue-actions"
import { cleanup, closeDb, db, makeUser, testId } from "./helpers"

/*
 * SCRUM-352 (epic SCRUM-349). An organiser could not add a venue — createVenue
 * refused them — so an outline drawn for a place that was not listed lived on
 * that one event and was redrawn for the next. Staging, 2026-09-27: 7 venues
 * against 20 events with no venue.
 *
 * Owner's ruling 2: the organisation that added an unclaimed venue, and admins,
 * may edit it; nobody else. Once claimed, the owner decides. An unclaimed venue
 * grants nobody operational control, so adding one is safe.
 */
const users: string[] = []
const orgs: string[] = []
const venues: string[] = []

afterAll(async () => {
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await cleanup(users, [])
  await closeDb()
})

async function member(label: string, role: "organizer" | "venue_owner" | "app_admin", withOrg = true) {
  const id = await makeUser(testId(label), role === "venue_owner" ? "organizer" : role)
  users.push(id)
  if (role === "venue_owner") await db.user.update({ where: { id }, data: { role } })
  let orgId: string | null = null
  if (withOrg) {
    const org = await db.organisations.create({
      data: { kind: "company", display_name: testId(`${label}-org`), status: "verified" },
    })
    orgs.push(org.id)
    await db.organisation_members.create({ data: { org_id: org.id, user_id: id, role: "owner" } })
    orgId = org.id
  }
  return { id, orgId, as: () => mockGetAuth.mockResolvedValue({ user: { id, role } }) }
}

// A place far from every seeded venue, so the duplicate check sees only ours.
const base = { lat: 12.6 + Math.random() * 0.05, lng: 77.1 + Math.random() * 0.05 }
const d = 0.0012 // ~265 m square: a stadium-sized outline
const outline = (c: { lat: number; lng: number }) => ({
  type: "polygon",
  buffer: 20,
  ring: [
    [c.lat - d, c.lng - d],
    [c.lat - d, c.lng + d],
    [c.lat + d, c.lng + d],
    [c.lat + d, c.lng - d],
  ],
})

async function added(c: { lat: number; lng: number }, extra: Partial<Parameters<typeof createVenue>[0]> = {}) {
  const { id } = await createVenue({
    name: testId("Test Grounds"),
    venueType: "stadium",
    lat: c.lat,
    lng: c.lng,
    geofence: outline(c),
    acknowledgedDuplicates: true,
    ...extra,
  })
  venues.push(id)
  return id
}

const row = (id: string) =>
  db.venues.findUniqueOrThrow({
    where: { id },
    select: { owner_org_id: true, created_by_org_id: true, geofence: true, name: true },
  })

describe("an organiser adds a venue", () => {
  it("unclaimed, recorded against their organisation, with its outline", async () => {
    const host = await member("oav-host", "organizer")
    host.as()
    const id = await added(base)
    const r = await row(id)
    expect(r.owner_org_id).toBeNull()
    expect(r.created_by_org_id).toBe(host.orgId)
    expect(r.geofence).toMatchObject({ type: "polygon", buffer: 20 })
  })

  it("is refused without an organisation — there is nobody to give the edit to", async () => {
    const loner = await member("oav-loner", "organizer", false)
    loner.as()
    await expect(added({ lat: base.lat + 0.01, lng: base.lng })).rejects.toThrow(/organisation/i)
  })

  it("an admin still adds unclaimed venues with no creating organisation", async () => {
    const admin = await member("oav-admin", "app_admin", false)
    admin.as()
    const id = await added({ lat: base.lat + 0.02, lng: base.lng })
    expect(await row(id)).toMatchObject({ owner_org_id: null, created_by_org_id: null })
  })
})

describe("who may edit an unclaimed venue (owner's ruling 2)", () => {
  it("its creating organisation may; another organiser's may not, and nothing is written", async () => {
    const host = await member("oav-edit-host", "organizer")
    const rival = await member("oav-edit-rival", "organizer")
    host.as()
    const c = { lat: base.lat + 0.03, lng: base.lng }
    const id = await added(c)

    await updateVenue(id, { name: "Renamed by its creator" })
    expect((await row(id)).name).toBe("Renamed by its creator")

    rival.as()
    await expect(updateVenue(id, { name: "Hijacked" })).rejects.toThrow(/forbidden/i)
    expect((await row(id)).name).toBe("Renamed by its creator")
  })

  it("once claimed, the owner decides — the creating organisation no longer edits", async () => {
    const host = await member("oav-claim-host", "organizer")
    const owner = await member("oav-claim-owner", "venue_owner")
    host.as()
    const id = await added({ lat: base.lat + 0.04, lng: base.lng })
    await db.venues.update({ where: { id }, data: { owner_org_id: owner.orgId, claimed_at: new Date() } })

    await expect(updateVenue(id, { name: "Too late" })).rejects.toThrow(/forbidden/i)
    owner.as()
    await updateVenue(id, { name: "The owner's name for it" })
    expect((await row(id)).name).toBe("The owner's name for it")
  })
})

describe("the duplicate check knows an outline, not only a pin", () => {
  it("refuses a new place whose pin is inside a listed venue's outline, 130 m from its pin", async () => {
    const host = await member("oav-dup", "organizer")
    host.as()
    const c = { lat: base.lat + 0.045, lng: base.lng + 0.02 }
    await added(c)
    // Inside the ~265 m outline, ~130 m from the listed venue's pin — beyond
    // the 100 m pin-to-pin rule, which is all the check knew before.
    const inside = { lat: c.lat + 0.00115, lng: c.lng }
    await expect(
      createVenue({ name: testId("Same Stadium"), venueType: "stadium", lat: inside.lat, lng: inside.lng })
    ).rejects.toThrow(/already listed/i)
  })
})
