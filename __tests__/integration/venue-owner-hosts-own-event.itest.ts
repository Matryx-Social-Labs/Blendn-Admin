/*
 * A venue owner can save the event the dashboard offers them (SCRUM-320).
 *
 * "Host it yourself and you are the organiser" (DESIGN_BRIEF_VENUES_AND_CONTROL):
 * `canCreateEvents` has included `venue_owner` since #285, and so have
 * /events/new, the Events page and `mayCreateEvents` — but `POST /api/events`
 * kept its March gate of admin-or-organiser. Driven on staging as
 * venue.owner@: "Create event", the whole editor, then "Forbidden" and no row.
 * Real rows.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
const mockGetAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: () => mockGetAuth() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
import { cleanup, closeDb, db, makeUser, testId } from "./helpers"
// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventsRoute = require("@/app/api/events/route") as typeof import("@/app/api/events/route")

const users: string[] = []
const orgs: string[] = []
const events: string[] = []

afterAll(async () => {
  await db.audit_logs.deleteMany({ where: { resource_id: { in: events } } })
  await db.events.deleteMany({ where: { id: { in: events } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await cleanup(users, [])
  await closeDb()
})

/** A member of a verified organisation, signed in with the given role. */
async function signedIn(label: string, role: "venue_owner" | "sponsor") {
  const id = await makeUser(testId(label))
  await db.user.update({ where: { id }, data: { role } })
  users.push(id)
  const org = await db.organisations.create({ data: { kind: "company", display_name: testId(`${label}-org`), status: "verified" } })
  orgs.push(org.id)
  await db.organisation_members.create({ data: { org_id: org.id, user_id: id, role: "owner", is_primary_contact: true } })
  mockGetAuth.mockResolvedValue({ user: { id, role } })
  return org.id
}

const START = new Date(Date.now() + 7 * 86_400_000)
const create = () =>
  eventsRoute.POST(
    new Request("http://localhost/api/events", {
      method: "POST",
      body: JSON.stringify({
        title: testId("vohe-event"),
        description: "integration fixture",
        start_time: START.toISOString(),
        end_time: new Date(START.getTime() + 3 * 3_600_000).toISOString(),
        timezone: "Asia/Kolkata",
        status: "draft",
      }),
    }) as never
  )

it("a venue owner's draft saves, owned by their organisation", async () => {
  const orgId = await signedIn("vohe-venue", "venue_owner")
  const res = await create()
  expect(res.status).toBe(200)
  const { id } = (await res.json()) as { id: string }
  events.push(id)
  const row = await db.events.findUniqueOrThrow({ where: { id }, select: { organizer_org_id: true, status: true } })
  expect(row).toEqual({ organizer_org_id: orgId, status: "draft" })
})

it("a sponsor is still refused — the reason the gate is an allowlist", async () => {
  await signedIn("vohe-sponsor", "sponsor")
  expect((await create()).status).toBe(403)
})
