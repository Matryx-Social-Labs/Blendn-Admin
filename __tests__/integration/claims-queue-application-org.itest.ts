/*
 * The claims queue names the organisation an approved application created
 * (SCRUM-454).
 *
 * A claim filed with no account carries `onboarding_id`, and its flags say
 * "no_organisation_yet". Once the application is approved, the organisation
 * is recorded on the request -- and the hand-over resolves it from there --
 * but the queue read only the claim's own `org_id`, so the row went on saying
 * "No account yet — approve their application first". Found on staging
 * (SCRUM-238), claim 375c3e7a, after its application was approved.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/auth", () => ({ getAuth: jest.fn().mockResolvedValue({ user: { id: "admin", role: "app_admin" } }) }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { getEventClaimQueue } from "@/lib/event-claim-actions"
import { closeDb, db, makeEvent, makeUser, testId } from "./helpers"

const users: string[] = []
const events: string[] = []
const orgs: string[] = []
const requests: string[] = []

afterAll(async () => {
  await db.event_claims.deleteMany({ where: { event_id: { in: events } } })
  await db.organiser_onboarding_requests.deleteMany({ where: { id: { in: requests } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await db.events.deleteMany({ where: { id: { in: events } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

async function application(orgId: string | null) {
  const r = await db.organiser_onboarding_requests.create({
    data: {
      kind: "company",
      display_name: testId("app"),
      contact_name: "Claimant",
      contact_email: `${testId("claimant")}@itest.invalid`,
      tier: "needs_proof",
      status: orgId ? "approved" : "pending",
      requested_role: "organizer",
      org_id: orgId,
    },
    select: { id: true, contact_email: true },
  })
  requests.push(r.id)
  return r
}

it("names the application's organisation once it exists, and drops the no-account flag", async () => {
  const host = await makeUser("claims_host")
  users.push(host)
  const eventId = await makeEvent(host)
  events.push(eventId)
  const org = await db.organisations.create({ data: { kind: "company", display_name: testId("Claimant Org"), status: "verified" } })
  orgs.push(org.id)

  const approved = await application(org.id)
  const waiting = await application(null)
  const withOrg = await db.event_claims.create({
    data: { event_id: eventId, onboarding_id: approved.id, contact_email: approved.contact_email, flags: ["no_organisation_yet"] },
  })
  const withoutOrg = await db.event_claims.create({
    data: { event_id: eventId, onboarding_id: waiting.id, contact_email: waiting.contact_email, flags: ["no_organisation_yet"] },
  })

  const { rows } = await getEventClaimQueue()
  const row = (id: string) => rows.find((r) => r.id === id)!

  expect(row(withOrg.id).orgName).toBe(org.display_name)
  expect(row(withOrg.id).flags).not.toContain("no_organisation_yet")
  // Still waiting on its application: still says so.
  expect(row(withoutOrg.id).orgName).toBeNull()
  expect(row(withoutOrg.id).flags).toContain("no_organisation_yet")
})
