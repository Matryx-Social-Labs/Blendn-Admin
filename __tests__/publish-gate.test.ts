const mockDb = {
  events: {
    create: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
  },
  user: { findUnique: jest.fn() },
  // Cancelling cascades to live check-ins (Fix #35), which is the one other
  // table these routes touch.
  event_check_ins: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
}
jest.mock("@/lib/db", () => ({ db: mockDb }))

const mockAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: () => mockAuth() }))

const mockMobileAuth = jest.fn()
jest.mock("@/lib/mobile-auth", () => ({
  getAuthenticatedUser: (...a: unknown[]) => mockMobileAuth(...a),
}))

jest.mock("@/lib/rate-limit", () => ({
  rateLimit: jest.fn().mockResolvedValue(null),
  userLimit: jest.fn().mockReturnValue({ windowMs: 1, maxRequests: 99 }),
}))

jest.mock("@/lib/org-membership", () => ({
  actorFor: jest.fn(async (u: { id: string; role: string }) => ({ ...u, orgIds: [] })),
}))

jest.mock("@/lib/venue-link", () => ({ resolveVenueLink: jest.fn().mockResolvedValue({}) }))
jest.mock("@/lib/occurrences", () => ({ syncOccurrences: jest.fn().mockResolvedValue(undefined) }))

import { NextRequest } from "next/server"

import { POST } from "@/app/api/events/route"
import { PATCH } from "@/app/api/events/[id]/route"
import { PATCH as mobilePatch } from "@/app/api/mobile/events/[eventId]/route"

/**
 * An event may not be published without somewhere to check in.
 *
 * `canPublish` in `lib/geofence-input.ts` existed for exactly this and had no
 * caller outside its own test, so every publish path accepted `published` with
 * no coordinates at all. The event went live, and then `POST
 * /api/mobile/events/[id]/checkin` refused every attendee at the door with
 * OUT_OF_RANGE — which reads as a broken app, not as an unfinished event. The
 * Overview's "Place it on the map" blocker was advisory the whole time.
 *
 * Asserted at the routes rather than on `canPublish`, because the defect was
 * never in the resolver: it was that nothing called it.
 */

const USER = "11111111-1111-1111-1111-111111111111"
const EVENT = "22222222-2222-2222-2222-222222222222"

const CIRCLE = { type: "circle", lat: 12.9716, lng: 77.5946, radius: 50, buffer: 25 }

const createBody = (over: Record<string, unknown> = {}) => ({
  title: "Summer Sessions",
  description: "An evening of records and conversation.",
  start_time: "2026-09-01T18:00:00.000Z",
  end_time: "2026-09-01T23:00:00.000Z",
  timezone: "Asia/Kolkata",
  ...over,
})

const postReq = (body: unknown) =>
  new Request("https://blendn.app/api/events", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  })

const patchReq = (body: unknown) =>
  new Request(`https://blendn.app/api/events/${EVENT}`, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  })

const ctx = { params: Promise.resolve({ id: EVENT }) }

/** The stored row, in the shape the PATCH route's `findFirst` returns. */
const storedEvent = (over: Record<string, unknown> = {}) => ({
  id: EVENT,
  status: "draft",
  title: "Summer Sessions",
  description: "An evening of records and conversation.",
  latitude: null,
  longitude: null,
  geofence: null,
  organizer_org_id: null,
  venue: null,
  venue_id: null,
  venue_link_status: null,
  start_time: new Date("2026-09-01T18:00:00.000Z"),
  end_time: new Date("2026-09-01T23:00:00.000Z"),
  timezone: "Asia/Kolkata",
  ...over,
})

beforeEach(() => {
  jest.clearAllMocks()
  mockAuth.mockResolvedValue({ user: { id: USER, role: "app_admin" } })
  mockMobileAuth.mockResolvedValue({ userId: USER })
  mockDb.user.findUnique.mockResolvedValue({ id: USER, role: "app_admin" })
  mockDb.events.findMany.mockResolvedValue([])
  mockDb.events.findFirst.mockResolvedValue(storedEvent())
  mockDb.events.findUnique.mockResolvedValue(storedEvent())
  mockDb.events.create.mockResolvedValue({
    id: EVENT,
    start_time: new Date("2026-09-01T18:00:00.000Z"),
  })
  mockDb.events.update.mockResolvedValue(storedEvent({ status: "published" }))
})

describe("POST /api/events cannot create an event that is born unpublishable", () => {
  it("refuses status=published with no coordinates", async () => {
    // The editor only ever posts `draft`; the route accepted whatever the body
    // said, and nothing in it looked at the location.
    const res = await POST(postReq(createBody({ status: "published" })))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("before publishing")
    expect(mockDb.events.create).not.toHaveBeenCalled()
  })

  it("lets the same event be created as a draft", async () => {
    const res = await POST(postReq(createBody({ status: "draft" })))
    expect(res.status).toBe(200)
    expect(mockDb.events.create).toHaveBeenCalled()
  })

  it("defaults to draft, and a default draft is never gated", async () => {
    const res = await POST(postReq(createBody()))
    expect(res.status).toBe(200)
    expect(mockDb.events.create.mock.calls[0][0].data.status).toBe("draft")
  })

  it("publishes when the pin is set", async () => {
    const res = await POST(
      postReq(createBody({ status: "published", latitude: 12.9716, longitude: 77.5946 }))
    )
    expect(res.status).toBe(200)
    expect(mockDb.events.create).toHaveBeenCalled()
  })

  it("publishes on a polygon geofence with no point", async () => {
    // A fence is a check-in area in its own right — requiring the point as well
    // would refuse an event that is perfectly checkable-into.
    const res = await POST(postReq(createBody({ status: "published", geofence: CIRCLE })))
    expect(res.status).toBe(200)
    expect(mockDb.events.create).toHaveBeenCalled()
  })
})

describe("PATCH /api/events/[id] gates the transition, not the state", () => {
  it("refuses to publish a draft with no coordinates", async () => {
    const res = await PATCH(patchReq({ status: "published" }), ctx)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("before publishing")
    expect(mockDb.events.update).not.toHaveBeenCalled()
  })

  it("accepts the pin and the publish in one request", async () => {
    // The organiser drops the pin and hits publish in a single save. Reading
    // only the stored row would refuse that and look like a bug.
    const res = await PATCH(
      patchReq({ status: "published", latitude: 12.9716, longitude: 77.5946 }),
      ctx
    )
    expect(res.status).toBe(200)
    expect(mockDb.events.update).toHaveBeenCalled()
  })

  it("accepts a geofence and the publish in one request", async () => {
    const res = await PATCH(patchReq({ status: "published", geofence: CIRCLE }), ctx)
    expect(res.status).toBe(200)
    expect(mockDb.events.update).toHaveBeenCalled()
  })

  it("publishes a draft that already has its coordinates stored", async () => {
    mockDb.events.findFirst.mockResolvedValue(
      storedEvent({ latitude: 12.9716, longitude: 77.5946 })
    )
    const res = await PATCH(patchReq({ status: "published" }), ctx)
    expect(res.status).toBe(200)
  })

  it("does not start failing edits to an already-published event", async () => {
    // Events published before this gate existed have no coordinates. Gating the
    // state rather than the transition would strand every one of them.
    mockDb.events.findFirst.mockResolvedValue(storedEvent({ status: "published" }))
    const res = await PATCH(patchReq({ title: "Summer Sessions", status: "published" }), ctx)
    expect(res.status).toBe(200)
    expect(mockDb.events.update).toHaveBeenCalled()
  })

  it("does not gate a cancellation, or any other status", async () => {
    mockDb.events.findFirst.mockResolvedValue(storedEvent({ status: "published" }))
    const res = await PATCH(patchReq({ status: "cancelled" }), ctx)
    expect(res.status).toBe(200)
  })
})

describe("PATCH /api/mobile/events/[eventId] closes the same door", () => {
  const mobileReq = (body: unknown) =>
    new NextRequest(`https://api.blendn.app/api/mobile/events/${EVENT}`, {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    })

  const mobileCtx = { params: Promise.resolve({ eventId: EVENT }) }

  it("refuses to publish an event with no coordinates from the app", async () => {
    const res = await mobilePatch(mobileReq({ status: "published" }), mobileCtx)
    expect(res.status).toBe(400)
    expect(mockDb.events.update).not.toHaveBeenCalled()
  })

  it("publishes one that has them", async () => {
    mockDb.events.findUnique.mockResolvedValue(
      storedEvent({ latitude: 12.9716, longitude: 77.5946 })
    )
    const res = await mobilePatch(mobileReq({ status: "published" }), mobileCtx)
    expect(res.status).toBe(200)
    expect(mockDb.events.update).toHaveBeenCalled()
  })
})

describe("slug collisions are absorbed on both write paths", () => {
  it("suffixes a created event whose title is already taken", async () => {
    mockDb.events.findMany.mockResolvedValue([{ slug: "summer-sessions" }])
    await POST(postReq(createBody()))
    expect(mockDb.events.create.mock.calls[0][0].data.slug).toBe("summer-sessions-2")
  })

  it("suffixes a renamed event whose new title is already taken", async () => {
    mockDb.events.findMany.mockResolvedValue([{ slug: "summer-sessions" }])
    await PATCH(patchReq({ title: "Summer Sessions" }), ctx)
    expect(mockDb.events.update.mock.calls[0][0].data.slug).toBe("summer-sessions-2")
  })

  it("excludes the event itself, so re-saving a title is not a collision", async () => {
    await PATCH(patchReq({ title: "Summer Sessions" }), ctx)
    expect(mockDb.events.findMany.mock.calls[0][0].where.id).toEqual({ not: EVENT })
  })
})
