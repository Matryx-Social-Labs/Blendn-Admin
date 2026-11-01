const mockGetAuth = jest.fn()
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/auth", () => ({ getAuth: async () => { const s = await mockGetAuth(); return s?.user ? { ...s, user: { signedInAt: 0, ...s.user } } : s } }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { setVenueAmenities } from "@/lib/venue-actions"
import { cleanup, closeDb, db, makeUser, testId } from "./helpers"

/*
 * SCRUM-979: nothing wrote venue_amenities, so every venue's "Good to know" in the app was empty. The owner's
 * organisation or an admin ticks them from the shared vocabulary (docs/AMENITIES.md § Authorisation); the
 * organisation that only added an unclaimed venue, and everyone else, cannot.
 */
const users: string[] = []
const orgs: string[] = []
const venues: string[] = []
const amenities: string[] = []

afterAll(async () => {
  await db.venue_amenities.deleteMany({ where: { venue_id: { in: venues } } })
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  await db.amenities.deleteMany({ where: { id: { in: amenities } } })
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await cleanup(users, [])
  await closeDb()
})

async function person(label: string, role: "venue_owner" | "organizer" | "app_admin") {
  const id = await makeUser(testId(label), role === "venue_owner" ? "organizer" : role)
  users.push(id)
  if (role === "venue_owner") await db.user.update({ where: { id }, data: { role } })
  const org = await db.organisations.create({ data: { kind: "company", display_name: testId(`${label}-org`), status: "verified" } })
  orgs.push(org.id)
  await db.organisation_members.create({ data: { org_id: org.id, user_id: id, role: "owner" } })
  return { id, orgId: org.id, as: () => mockGetAuth.mockResolvedValue({ user: { id, role } }) }
}

async function amenity(label: string, isActive = true) {
  const a = await db.amenities.create({ data: { name: label, slug: testId(label.toLowerCase()), is_active: isActive } })
  amenities.push(a.id)
  return a.id
}

async function venue(data: { owner_org_id?: string; created_by_org_id?: string }) {
  const v = await db.venues.create({
    data: {
      name: testId("Amenity Hall"),
      latitude: 12.97,
      longitude: 77.59,
      ...(data.owner_org_id ? { owner_org_id: data.owner_org_id, claimed_at: new Date() } : {}),
      ...(data.created_by_org_id ? { created_by_org_id: data.created_by_org_id } : {}),
    },
  })
  venues.push(v.id)
  return v.id
}

const ticked = async (venueId: string) =>
  (await db.venue_amenities.findMany({ where: { venue_id: venueId }, select: { amenity_id: true } })).map((r) => r.amenity_id).sort()

it("lets the owner's organisation set the list, replacing it, and audits it", async () => {
  const owner = await person("am-owner", "venue_owner")
  const v = await venue({ owner_org_id: owner.orgId })
  const [a, b, c] = [await amenity("Parking"), await amenity("Wi-Fi"), await amenity("Coat check")]
  owner.as()
  await setVenueAmenities(v, [a, b])
  expect(await ticked(v)).toEqual([a, b].sort())
  await setVenueAmenities(v, [c, b, c])
  expect(await ticked(v)).toEqual([b, c].sort())
  const audit = await db.audit_logs.findFirst({ where: { resource_id: v, action: "venue.amenities_set" }, orderBy: { created_at: "desc" } })
  expect(audit?.user_id).toBe(owner.id)
  await setVenueAmenities(v, [])
  expect(await ticked(v)).toEqual([])
})

it("lets an admin set any venue's list", async () => {
  const admin = await person("am-admin", "app_admin")
  const v = await venue({})
  const a = await amenity("Step-free")
  admin.as()
  await setVenueAmenities(v, [a])
  expect(await ticked(v)).toEqual([a])
})

it("refuses another venue owner, and the organisation that only added an unclaimed venue", async () => {
  const owner = await person("am-owner2", "venue_owner")
  const stranger = await person("am-stranger", "venue_owner")
  const adder = await person("am-adder", "organizer")
  const owned = await venue({ owner_org_id: owner.orgId })
  const unclaimed = await venue({ created_by_org_id: adder.orgId })
  const a = await amenity("Garden")
  stranger.as()
  await expect(setVenueAmenities(owned, [a])).rejects.toThrow()
  adder.as()
  await expect(setVenueAmenities(unclaimed, [a])).rejects.toThrow(/owner|admin/i)
  expect(await ticked(owned)).toEqual([])
  expect(await ticked(unclaimed)).toEqual([])
})

it("refuses an unknown or retired amenity and writes nothing", async () => {
  const owner = await person("am-owner3", "venue_owner")
  const v = await venue({ owner_org_id: owner.orgId })
  const live = await amenity("Rooftop")
  const retired = await amenity("Smoking area", false)
  owner.as()
  await setVenueAmenities(v, [live])
  await expect(setVenueAmenities(v, [retired])).rejects.toThrow(/amenit/i)
  await expect(setVenueAmenities(v, ["not-a-uuid"])).rejects.toThrow(/amenit/i)
  // A malformed call is refused, not read as "none" (review): the list must survive it.
  await expect(setVenueAmenities(v, null as unknown as string[])).rejects.toThrow(/amenit/i)
  expect(await ticked(v)).toEqual([live])
})
