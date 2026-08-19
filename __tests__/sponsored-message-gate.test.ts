/*
 * The dashboard route that actually creates sponsored messages must enforce
 * `may_sponsor`.
 *
 * This test exists because `__tests__/broadcast-permissions.test.ts` pins all
 * twenty rows of the `canBroadcast` truth table — including "sponsored requires
 * the org flag" — and passed green the entire time the dashboard route ignored
 * it. The route checked `eventPermissions(...).canEdit` and never called the
 * resolver at all.
 *
 * So the scarcity rule was enforced on the mobile announce path, which nothing
 * calls with `kind: "sponsored"`, and not on the path the product uses. Any
 * organiser could label their own content as paid placement and have
 * `sponsoredMessageScheduler` fan it into the room on a timer.
 *
 * A unit test on the resolver cannot catch that. Only a test that invokes the
 * handler can, which is what this is. It asserts the refusal AND that nothing
 * was written, because a 403 that still creates the row is the same bug wearing
 * a different status code.
 */

const mockDb = {
  events: { findUnique: jest.fn() },
  organisations: { count: jest.fn() },
  organisation_members: { findMany: jest.fn() },
  event_sponsored_messages: { create: jest.fn(), findMany: jest.fn() },
}

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

const params = Promise.resolve({ id: EVENT })

const req = () =>
  new Request(`https://admin.blendn.app/api/events/${EVENT}/sponsored-messages`, {
    method: "POST",
    body: JSON.stringify({ content: "Stay hydrated", interval_minutes: 30 }),
  })

beforeEach(() => {
  jest.clearAllMocks()
  // An organiser who genuinely operates this event: canEdit would say yes.
  mockAuth.mockResolvedValue({ user: { id: USER, role: "organizer" } })
  mockDb.events.findUnique.mockResolvedValue({
    organizer_org_id: ORG,
    venue: null,
  })
  mockDb.organisation_members.findMany.mockResolvedValue([{ org_id: ORG }])
  mockDb.event_sponsored_messages.create.mockResolvedValue({ id: "new" })
})

describe("POST sponsored-messages enforces may_sponsor", () => {
  it("refuses an organiser whose org may not sell placement, and writes nothing", async () => {
    // No organisation of theirs carries the flag.
    mockDb.organisations.count.mockResolvedValue(0)

    const res = await POST(req(), { params })

    expect(res.status).toBe(403)
    expect(mockDb.event_sponsored_messages.create).not.toHaveBeenCalled()
  })

  it("allows the same organiser once their org is approved", async () => {
    mockDb.organisations.count.mockResolvedValue(1)

    const res = await POST(req(), { params })

    expect(res.status).toBe(201)
    expect(mockDb.event_sponsored_messages.create).toHaveBeenCalledTimes(1)
  })

  it("refuses an organiser from an unrelated org even with the flag", async () => {
    // Flag yes, but they operate a different event.
    mockDb.organisations.count.mockResolvedValue(1)
    mockDb.organisation_members.findMany.mockResolvedValue([{ org_id: "other-org" }])

    const res = await POST(req(), { params })

    expect(res.status).toBe(403)
    expect(mockDb.event_sponsored_messages.create).not.toHaveBeenCalled()
  })

  it("lets an app_admin place one without the flag — they are the platform", async () => {
    mockAuth.mockResolvedValue({ user: { id: USER, role: "app_admin" } })
    mockDb.organisations.count.mockResolvedValue(0)

    const res = await POST(req(), { params })

    expect(res.status).toBe(201)
  })
})
