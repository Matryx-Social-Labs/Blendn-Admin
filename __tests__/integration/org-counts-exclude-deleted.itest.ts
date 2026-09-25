/*
 * An organisation's counts are of what it runs, not of every row it ever had
 * (SCRUM-167).
 *
 * Driven on staging 2026-09-25: /dashboard/organisations read "39 events" for
 * Nightshift Collective, which runs 26, and "12 events" for an org that runs
 * none. `_count` counts every row; the soft delete is a column Prisma does not
 * know about. The organisations CSV in /dashboard/reports carried the same
 * `_count`. Real rows.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
const mockGetAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: () => mockGetAuth() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
import { getOrganisations } from "@/lib/onboarding-actions"
import { buildReport } from "@/lib/reports"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"

const users: string[] = []
const events: string[] = []
const venues: string[] = []
let orgId = ""
let adminId = ""

beforeAll(async () => {
  adminId = await makeUser(testId("occ-admin"), "app_admin")
  const host = await makeUser(testId("occ-host"), "organizer")
  users.push(adminId, host)
  mockGetAuth.mockResolvedValue({ user: { id: adminId, role: "app_admin" } })

  orgId = (await db.organisations.create({ data: { kind: "company", display_name: testId("occ-org"), status: "verified" } })).id
  await db.organisation_members.create({ data: { org_id: orgId, user_id: host, role: "owner", is_primary_contact: true } })

  for (const deleted_at of [null, new Date()]) {
    const eventId = await makeEvent(host, { deleted_at })
    events.push(eventId)
    await db.events.update({ where: { id: eventId }, data: { organizer_org_id: orgId } })
    const venue = await db.venues.create({ data: { name: testId("occ-venue"), city: "Bangalore", owner_org_id: orgId, deleted_at } })
    venues.push(venue.id)
  }
})

afterAll(async () => {
  await db.events.deleteMany({ where: { id: { in: events } } })
  await db.venues.deleteMany({ where: { id: { in: venues } } })
  if (orgId) await db.organisations.delete({ where: { id: orgId } })
  await cleanup(users, [])
  await closeDb()
})

it("the organisations page counts the live event and the live venue, not the deleted ones", async () => {
  const org = (await getOrganisations()).find((o) => o.id === orgId)
  expect(org).toMatchObject({ memberCount: 1, eventCount: 1, venueCount: 1 })
})

it("the organisations CSV says the same", async () => {
  const csv = await buildReport("organisations", "app_admin", adminId, { key: "custom", from: new Date(0), to: new Date() })
  const [header, ...rows] = csv.trim().split("\n")
  const columns = header.split(",")
  const row = rows.find((r) => r.startsWith(orgId))!.split(",")
  expect(row[columns.indexOf("Members")]).toBe("1")
  expect(row[columns.indexOf("Events")]).toBe("1")
  expect(row[columns.indexOf("Venues")]).toBe("1")
})
