/*
 * `decideEventClaim`, invoked — the source scans in event-claims.test.ts pin
 * shapes, and the coverage pass showed a mutation they cannot see: select
 * `id` instead of `org_id` from the onboarding request and every regex still
 * matches while no no-account claim can ever be approved again.
 *
 * And the security pass's finding on the same change: the organisation was
 * resolved from whatever `onboarding_id` the claim carried, and filing is
 * public. Anyone who knew an approved request's uuid could have had an event
 * handed to that organisation. The request's contact address must be the
 * claim's, at filing and again here.
 */
const mockDb = {
  event_claims: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  organiser_onboarding_requests: { findUnique: jest.fn() },
  events: { update: jest.fn() },
  $transaction: jest.fn(),
}
mockDb.$transaction.mockImplementation(async (fn: (tx: typeof mockDb) => Promise<void>) => fn(mockDb))
const auditLog = jest.fn()
jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("@/lib/audit-log", () => ({ auditLog }))
jest.mock("@/lib/auth", () => ({ getAuth: jest.fn().mockResolvedValue({ user: { id: "admin", role: "app_admin" } }) }))
jest.mock("next/headers", () => ({ headers: jest.fn().mockResolvedValue({ get: () => "203.0.113.9" }) }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
jest.mock("@/lib/rate-limit-store", () => ({ hit: jest.fn().mockResolvedValue({ count: 1 }) }))
jest.mock("@/lib/event-ownership", () => ({ owningOrgFor: jest.fn() }))

import { decideEventClaim, fileEventClaim } from "@/lib/event-claim-actions"
import { getAuth } from "@/lib/auth"

/*
 * A mock that honours `select`, so a wrong column list is a wrong answer here
 * too. With a mock that returns the whole row, the coverage pass's mutation —
 * select `id` instead of `org_id` — stays green while the hand-over is dead.
 */
function selecting(row: Record<string, unknown>) {
  return ({ select }: { select?: Record<string, boolean> }) =>
    Promise.resolve(
      select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]])) : row
    )
}

const DAY = 24 * 60 * 60 * 1000
const claimable = {
  id: "e1",
  title: "Indie Sundowner",
  curated_at: new Date("2026-09-01"),
  claimed_at: null,
  start_time: new Date(Date.now() + 2 * DAY),
  end_time: new Date(Date.now() + 2 * DAY + 3 * 60 * 60 * 1000),
}

beforeEach(() => {
  jest.clearAllMocks()
  mockDb.$transaction.mockImplementation(async (fn: (tx: typeof mockDb) => Promise<void>) => fn(mockDb))
})

function noAccountClaim(overrides: Partial<{ contact_email: string }> = {}) {
  mockDb.event_claims.findUnique.mockResolvedValue({
    id: "c1",
    status: "pending",
    org_id: null,
    onboarding_id: "req1",
    contact_email: "events@toit.in",
    event: claimable,
    ...overrides,
  })
}

describe("handing over a claim filed without an account", () => {
  it("takes the organisation from the approved application and records it on the claim", async () => {
    noAccountClaim()
    mockDb.organiser_onboarding_requests.findUnique.mockImplementation(
      selecting({ id: "req1", org_id: "org9", contact_email: "events@toit.in", status: "approved" })
    )

    await decideEventClaim("c1", "approve")

    expect(mockDb.event_claims.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "approved", org_id: "org9", onboarding_id: null }),
      })
    )
    expect(mockDb.events.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "e1" }, data: expect.objectContaining({ organizer_org_id: "org9" }) })
    )
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "event_claim.approved", details: expect.objectContaining({ orgId: "org9" }) }))
  })

  it("still refuses while the application is not approved", async () => {
    noAccountClaim()
    mockDb.organiser_onboarding_requests.findUnique.mockResolvedValue({ org_id: null, contact_email: "events@toit.in" })
    await expect(decideEventClaim("c1", "approve")).rejects.toThrow("Approve their application first")
    expect(mockDb.$transaction).not.toHaveBeenCalled()
  })

  it("refuses an application that belongs to a different email address", async () => {
    // The hijack: a claim under evil@x carrying somebody else's approved request id.
    noAccountClaim({ contact_email: "evil@example.com" })
    mockDb.organiser_onboarding_requests.findUnique.mockResolvedValue({ org_id: "org9", contact_email: "events@toit.in" })
    await expect(decideEventClaim("c1", "approve")).rejects.toThrow("different email address")
    expect(mockDb.events.update).not.toHaveBeenCalled()
  })

  it("matches the email case-insensitively", async () => {
    noAccountClaim({ contact_email: "Events@Toit.in" })
    mockDb.organiser_onboarding_requests.findUnique.mockResolvedValue({ org_id: "org9", contact_email: "events@toit.in" })
    await decideEventClaim("c1", "approve")
    expect(mockDb.events.update).toHaveBeenCalled()
  })
})

describe("a claim that already has an organisation", () => {
  it("does not consult the onboarding table and leaves the claim's org alone", async () => {
    mockDb.event_claims.findUnique.mockResolvedValue({
      id: "c2", status: "pending", org_id: "org2", onboarding_id: null, contact_email: "x@y.z", event: claimable,
    })
    await decideEventClaim("c2", "approve")
    expect(mockDb.organiser_onboarding_requests.findUnique).not.toHaveBeenCalled()
    expect(mockDb.event_claims.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.not.objectContaining({ org_id: expect.anything() }) })
    )
    expect(mockDb.events.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ organizer_org_id: "org2" }) })
    )
  })
})

describe("filing with somebody else's application", () => {
  it("is refused before anything is written", async () => {
    // Anonymous caller: no session, no org.
    ;(getAuth as jest.Mock).mockResolvedValueOnce(null)
    mockDb.organiser_onboarding_requests.findUnique.mockImplementation(
      selecting({ id: "req1", contact_email: "events@toit.in", org_id: "org9" })
    )
    const result = await fileEventClaim({
      eventId: "e1",
      contactEmail: "evil@example.com",
      onboardingId: "req1",
    })
    expect(result).toEqual({ ok: false, error: "That application does not match this email address" })
    // No `create` on the mock at all — a write would have thrown, not returned.
  })
})
