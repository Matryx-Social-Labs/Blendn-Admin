/*
 * The dashboard route that actually creates sponsored messages must enforce the
 * grant.
 *
 * This test exists because `__tests__/broadcast-permissions.test.ts` pins every
 * row of the `canBroadcast` truth table — including "sponsored requires the org
 * flag" — and passed green the entire time the dashboard route ignored it. The
 * route checked `eventPermissions(...).canEdit` and never called the resolver
 * at all.
 *
 * So the rule was enforced on the mobile announce path, which nothing calls
 * with `kind: "sponsored"`, and not on the path the product uses. Any organiser
 * could label their own content as paid placement and have the scheduler fan it
 * into the room on a timer.
 *
 * A unit test on the resolver cannot catch that. Only a test that invokes the
 * handler can, which is what this is. It asserts the refusal AND that nothing
 * was written, because a 403 that still creates the row is the same bug wearing
 * a different status code.
 */

const mockDb = {
  events: { findUnique: jest.fn() },
  organisations: { findFirst: jest.fn() },
  organisation_members: { findMany: jest.fn() },
  event_sponsors: { findFirst: jest.fn() },
  event_sponsored_messages: { create: jest.fn(), findMany: jest.fn() },
  sponsored_creatives: { create: jest.fn() },
  $transaction: jest.fn(),
}

/*
 * Runs the callback against the same mocks: the route creates the campaign and
 * its first creative together, and a test that stubbed the transaction away
 * would not notice if one of the two stopped happening.
 *
 * Wired after the literal rather than inside it — referencing `mockDb` in its
 * own initializer makes the whole object implicitly `any`.
 */
mockDb.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(mockDb))

const mockAuth = jest.fn()

jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("@/lib/auth", () => ({ getAuth: () => mockAuth() }))
// The limiter is a no-op here; the gate must refuse before it is reached.
jest.mock("@/lib/rate-limit", () => ({
  rateLimit: jest.fn().mockResolvedValue(null),
  createUserRateLimit: jest.fn(),
}))

import { POST } from "@/app/api/events/[id]/sponsored-messages/route"

const EVENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const ORG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const USER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const SPONSOR = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"

const params = Promise.resolve({ id: EVENT })

const req = () =>
  new Request(`https://admin.blendn.app/api/events/${EVENT}/sponsored-messages`, {
    method: "POST",
    body: JSON.stringify({
      sponsor_id: SPONSOR,
      content: "Stay hydrated",
      interval_minutes: 30,
    }),
  })

beforeEach(() => {
  jest.clearAllMocks()
  // An organiser who genuinely operates this event: `canEdit` would say yes.
  mockAuth.mockResolvedValue({ user: { id: USER, role: "organizer" } })
  mockDb.events.findUnique.mockResolvedValue({ organizer_org_id: ORG, venue: null })
  mockDb.organisation_members.findMany.mockResolvedValue([{ org_id: ORG }])
  mockDb.event_sponsored_messages.create.mockResolvedValue({ id: "new" })
  mockDb.sponsored_creatives.create.mockResolvedValue({ id: "creative" })
  // The brand named in the body does place at this event, and belongs to the
  // granted org. The gate tests below vary the grant, not this.
  mockDb.event_sponsors.findFirst.mockResolvedValue({ id: "placement" })
  // Default: no organisation satisfies BOTH conditions.
  mockDb.organisations.findFirst.mockResolvedValue(null)
})

describe("POST sponsored-messages enforces the sponsor grant", () => {
  it("refuses when no org holds both the flag and a placement, and writes nothing", async () => {
    const res = await POST(req(), { params })

    expect(res.status).toBe(403)
    expect(mockDb.event_sponsored_messages.create).not.toHaveBeenCalled()
  })

  it("allows it once one org holds both", async () => {
    mockDb.organisations.findFirst.mockResolvedValue({ id: ORG })

    const res = await POST(req(), { params })

    expect(res.status).toBe(201)
    expect(mockDb.event_sponsored_messages.create).toHaveBeenCalledTimes(1)
  })

  it("asks for the flag and the placement in ONE query, on ONE org", async () => {
    /*
     * The confused deputy this redesign exists to make unrepresentable.
     *
     * When these were two independent booleans, a person who is staff at Org A
     * (holds `may_sponsor`, no placement) and Org B (holds a placement, no
     * flag) satisfied both checks — and posted a sponsored message neither
     * organisation was entitled to send.
     *
     * Asserting the SHAPE of the query is the only way to catch a regression
     * back to two lookups: a test that mocks two booleans would happily pass
     * with the bug restored.
     */
    mockDb.organisations.findFirst.mockResolvedValue({ id: ORG })
    await POST(req(), { params })

    expect(mockDb.organisations.findFirst).toHaveBeenCalledTimes(1)
    const where = mockDb.organisations.findFirst.mock.calls[0][0].where

    // Both conditions, on the same row.
    expect(where.may_sponsor).toBe(true)
    expect(where.sponsors.some.placements.some).toMatchObject({
      event_id: EVENT,
      status: "approved",
    })
    // And scoped to organisations this actor actually belongs to.
    expect(where.id.in).toContain(ORG)
  })

  it("excludes merged-away and deleted brands from the grant", async () => {
    // A brand that lost a merge keeps its rows until they are repointed. It
    // must not grant anybody anything in the meantime.
    mockDb.organisations.findFirst.mockResolvedValue({ id: ORG })
    await POST(req(), { params })

    const some = mockDb.organisations.findFirst.mock.calls[0][0].where.sponsors.some
    expect(some.deleted_at).toBeNull()
    expect(some.merged_into).toBeNull()
  })

  it("refuses a brand the granted org does not own", async () => {
    /*
     * The second half of the same confused-deputy problem.
     *
     * `resolveSponsorGrant` proves *an* organisation of this actor's has
     * `may_sponsor` and an approved placement here. It says nothing about which
     * brand `sponsor_id` names. Without the ownership filter, one legitimate
     * placement is a licence to file campaigns under any brand on the platform —
     * including a competitor's, in a room where the brand is the only named
     * participant.
     */
    mockDb.organisations.findFirst.mockResolvedValue({ id: ORG })
    mockDb.event_sponsors.findFirst.mockResolvedValue(null)

    const res = await POST(req(), { params })

    expect(res.status).toBe(403)
    expect(mockDb.event_sponsored_messages.create).not.toHaveBeenCalled()
  })

  it("scopes the placement lookup to the granted org, not just the event", async () => {
    mockDb.organisations.findFirst.mockResolvedValue({ id: ORG })
    await POST(req(), { params })

    const where = mockDb.event_sponsors.findFirst.mock.calls[0][0].where
    expect(where).toMatchObject({ event_id: EVENT, sponsor_id: SPONSOR, status: "approved" })
    expect(where.sponsor.org_id).toBe(ORG)
  })

  it("creates the campaign and its first creative together", async () => {
    /*
     * A campaign with no creative row is one the scheduler skips: a send records
     * against `creative_id`, so there is nothing to record and nothing goes out.
     * The switch would say on and the room would stay quiet.
     */
    mockDb.organisations.findFirst.mockResolvedValue({ id: ORG })
    await POST(req(), { params })

    expect(mockDb.$transaction).toHaveBeenCalledTimes(1)
    expect(mockDb.sponsored_creatives.create).toHaveBeenCalledTimes(1)
    expect(mockDb.sponsored_creatives.create.mock.calls[0][0].data).toMatchObject({
      message_id: "new",
      content: "Stay hydrated",
    })
  })

  it("lets an app_admin place one without any grant", async () => {
    mockAuth.mockResolvedValue({ user: { id: USER, role: "app_admin" } })

    const res = await POST(req(), { params })

    expect(res.status).toBe(201)
    // An admin short-circuits before the resolver, so no query is issued.
    expect(mockDb.organisations.findFirst).not.toHaveBeenCalled()
    // And with no grant to scope by, the placement alone is the check —
    // `org_id: undefined` would silently match every brand.
    const sponsor = mockDb.event_sponsors.findFirst.mock.calls[0][0].where.sponsor
    expect("org_id" in sponsor).toBe(false)
  })
})
