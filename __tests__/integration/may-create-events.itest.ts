/*
 * "Create event" is offered only to an account that can publish (SCRUM-145).
 *
 * Driven on staging: daniel.weber@ (an organiser in no organisation) and a
 * member of a suspended organisation were both offered "Create event" and the
 * whole form, and refused only at save by `owningOrgFor`. One predicate now
 * answers for the Overview, the Events page and /events/new. Real rows.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
import { mayCreateEvents } from "@/lib/event-ownership"
import { cleanup, closeDb, db, makeUser, testId } from "./helpers"

const users: string[] = []
const orgs: string[] = []
afterAll(async () => {
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await cleanup(users, [])
  await closeDb()
})

async function member(label: string, status: "verified" | "suspended") {
  const id = await makeUser(testId(label), "organizer")
  users.push(id)
  const org = await db.organisations.create({ data: { kind: "company", display_name: testId(`${label}-org`), status } })
  orgs.push(org.id)
  await db.organisation_members.create({ data: { org_id: org.id, user_id: id, role: "owner" } })
  return id
}

it("says yes to an organiser in a live organisation, and to an admin", async () => {
  expect(await mayCreateEvents({ id: await member("mce-live", "verified"), role: "organizer" })).toBe(true)
  const admin = await makeUser(testId("mce-admin"), "app_admin")
  users.push(admin)
  expect(await mayCreateEvents({ id: admin, role: "app_admin" })).toBe(true)
})

it("says no to an organiser in no organisation, and to a member of a suspended one", async () => {
  const loner = await makeUser(testId("mce-loner"), "organizer")
  users.push(loner)
  expect(await mayCreateEvents({ id: loner, role: "organizer" })).toBe(false)
  expect(await mayCreateEvents({ id: await member("mce-suspended", "suspended"), role: "organizer" })).toBe(false)
})

it("says no to a role that never creates events", async () => {
  const attendee = await makeUser(testId("mce-attendee"))
  users.push(attendee)
  expect(await mayCreateEvents({ id: attendee, role: "attendee" })).toBe(false)
})
