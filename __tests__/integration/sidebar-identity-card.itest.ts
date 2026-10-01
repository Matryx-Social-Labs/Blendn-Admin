/*
 * The sidebar's identity card names the organisation a new event would belong
 * to (step 14). Real rows.
 *
 * `activeOrgsFor` lists a person's live organisations for the card; its first
 * entry is the one the card names. If its ordering or its suspension filter
 * drifted from `homeOrgIdFor`'s, the card would name one organisation while
 * Create event filed the event under another, and a suspended organisation
 * would be presented as the one you act for.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
import { homeOrgIdFor } from "@/lib/event-ownership"
import { activeOrgsFor } from "@/lib/org-membership"
import { cleanup, closeDb, db, makeUser, testId } from "./helpers"

const users: string[] = []
const orgs: string[] = []
afterAll(async () => {
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await cleanup(users, [])
  await closeDb()
})

async function join(userId: string, label: string, status: "verified" | "suspended", joinedAt: Date) {
  const org = await db.organisations.create({
    data: { kind: "company", display_name: testId(label), status },
  })
  orgs.push(org.id)
  await db.organisation_members.create({
    data: { org_id: org.id, user_id: userId, role: "staff", created_at: joinedAt },
  })
  return org.id
}

it("lists live organisations oldest first, and the first is the home one", async () => {
  const id = await makeUser(testId("card-multi"), "organizer")
  users.push(id)
  // Joined newest-first on purpose, so insertion order cannot pass for ordering.
  const newer = await join(id, "card-newer", "verified", new Date("2026-05-01T00:00:00Z"))
  const suspended = await join(id, "card-suspended", "suspended", new Date("2025-01-01T00:00:00Z"))
  const older = await join(id, "card-older", "verified", new Date("2026-01-01T00:00:00Z"))

  const listed = await activeOrgsFor(id)
  expect(listed.map((o) => o.id)).toEqual([older, newer])
  expect(listed.map((o) => o.id)).not.toContain(suspended)
  expect(listed[0].id).toBe(await homeOrgIdFor({ id, role: "organizer" }))
})

it("lists nothing for an organiser in no live organisation", async () => {
  const id = await makeUser(testId("card-none"), "organizer")
  users.push(id)
  await join(id, "card-only-suspended", "suspended", new Date("2026-01-01T00:00:00Z"))
  expect(await activeOrgsFor(id)).toEqual([])
})
