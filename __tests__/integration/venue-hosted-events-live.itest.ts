/*
 * A venue's hosting history is the events it hosted, not every row it ever had
 * (SCRUM-312).
 *
 * Driven on staging 2026-09-25: the claim form for QA Circle Venue told the
 * claimant its owner "has hosted 32 events here", and that "their hosting
 * history counts as evidence". The venue has 11 live events and 21 deleted
 * ones. The admin's claim queue flag, "Already owned by X (N hosted events)",
 * carried the same bare `_count`. This is the SCRUM-167 shape one join down.
 * Real rows.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
const mockGetAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: () => mockGetAuth() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
jest.mock("next/navigation", () => ({
  redirect: (to: string) => { throw new Error(`redirect ${to}`) },
  notFound: () => { throw new Error("notFound") },
}))
import { getVenueClaimQueue } from "@/lib/venue-claim-actions"
import ClaimVenuePage from "@/app/dashboard/venues/[id]/claim/page"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"

const users: string[] = []
const events: string[] = []
const orgs: string[] = []
let venueId = ""
let adminId = ""
let claimantId = ""
let ownerOrgName = ""

async function org(label: string, memberId: string) {
  const o = await db.organisations.create({ data: { kind: "company", display_name: testId(label), status: "verified" } })
  orgs.push(o.id)
  await db.organisation_members.create({ data: { org_id: o.id, user_id: memberId, role: "owner", is_primary_contact: true } })
  return o
}

beforeAll(async () => {
  adminId = await makeUser(testId("vhe-admin"), "app_admin")
  const owner = await makeUser(testId("vhe-owner"), "organizer")
  claimantId = await makeUser(testId("vhe-claimant"), "organizer")
  users.push(adminId, owner, claimantId)
  await db.user.update({ where: { id: claimantId }, data: { role: "venue_owner" } })

  const ownerOrg = await org("vhe-owner-org", owner)
  ownerOrgName = ownerOrg.display_name
  const claimantOrg = await org("vhe-claimant-org", claimantId)

  venueId = (await db.venues.create({ data: { name: testId("vhe-venue"), city: "Bangalore", owner_org_id: ownerOrg.id } })).id
  for (const deleted_at of [null, new Date()]) {
    const eventId = await makeEvent(owner, { deleted_at })
    events.push(eventId)
    await db.events.update({ where: { id: eventId }, data: { venue_id: venueId } })
  }
  await db.venue_claims.create({
    data: { venue_id: venueId, org_id: claimantOrg.id, filed_by: claimantId, is_dispute: true, status: "pending" },
  })
})

afterAll(async () => {
  await db.venue_claims.deleteMany({ where: { venue_id: venueId } })
  await db.events.deleteMany({ where: { id: { in: events } } })
  if (venueId) await db.venues.delete({ where: { id: venueId } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await cleanup(users, [])
  await closeDb()
})

/** The first element in the rendered tree that carries `hostedEvents`. */
function hostedEventsIn(node: unknown): number | undefined {
  if (!node || typeof node !== "object") return undefined
  const props = (node as { props?: Record<string, unknown> }).props
  if (!props) return undefined
  if (typeof props.hostedEvents === "number") return props.hostedEvents
  const children = ([] as unknown[]).concat(props.children ?? [])
  for (const child of children) {
    const found = hostedEventsIn(child)
    if (found !== undefined) return found
  }
  return undefined
}

it("tells the claimant the owner hosted the one live event, not the deleted one", async () => {
  mockGetAuth.mockResolvedValue({ user: { id: claimantId, role: "venue_owner" } })
  const page = await ClaimVenuePage({ params: Promise.resolve({ id: venueId }) })
  expect(hostedEventsIn(page)).toBe(1)
})

it("flags the dispute in the admin's queue with the same count", async () => {
  mockGetAuth.mockResolvedValue({ user: { id: adminId, role: "app_admin" } })
  const row = (await getVenueClaimQueue()).find((c) => c.venueId === venueId)
  expect(row?.currentOwnerEventCount).toBe(1)
  expect(row?.flags).toContain(`Already owned by ${ownerOrgName} (1 hosted event)`)
})
