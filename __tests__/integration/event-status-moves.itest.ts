/*
 * Which status moves a client may make, through the real handlers (SCRUM review
 * of PR #760, H-1). `cancelled` and `completed` are public — the app opens
 * them, the share page serves them — so reaching either without passing
 * through `published` skipped every publish check, for any organizer. And
 * Razorpay's review organisation may take nothing out of draft, add or link
 * no venue, invite nobody and claim nothing, at every door.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
const mockGetAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: async () => { const s = await mockGetAuth(); return s?.user ? { ...s, user: { signedInAt: 0, ...s.user } } : s } }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
jest.mock("@/lib/push-notifications", () => ({
  ...jest.requireActual("@/lib/push-notifications"),
  notifyEventUpdate: jest.fn().mockResolvedValue({ sent: 0, failed: 0 }),
}))
import { NextRequest } from "next/server"

import { fileEventClaim } from "@/lib/event-claim-actions"
import { CANCEL_DRAFT_REFUSAL, COMPLETED_REFUSAL, CREATE_STATUS_REFUSAL } from "@/lib/event-status-move"
import { signAccessToken } from "@/lib/mobile-auth"
import { inviteMember } from "@/lib/org-actions"
import { REVIEW_ORG_REFUSAL } from "@/lib/review-demo-org"
import { createVenue } from "@/lib/venue-actions"
import { ensureRazorpayReviewAccount } from "@/scripts/seed-razorpay-review"

import { cleanup, closeDb, db, makeUser, testId } from "./helpers"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventRoute = require("@/app/api/events/[id]/route") as typeof import("@/app/api/events/[id]/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventsRoute = require("@/app/api/events/route") as typeof import("@/app/api/events/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mobileEventRoute = require("@/app/api/mobile/events/[eventId]/route") as typeof import("@/app/api/mobile/events/[eventId]/route")

const users: string[] = []
const orgs: string[] = []
const tag = testId("esm")

afterAll(async () => {
  const events = await db.events.findMany({ where: { organizer_org_id: { in: orgs } }, select: { id: true } })
  const ids = events.map((e) => e.id)
  await db.audit_logs.deleteMany({ where: { OR: [{ resource_id: { in: [...ids, ...orgs] } }, { org_id: { in: orgs } }] } })
  await db.event_occurrences.deleteMany({ where: { event_id: { in: ids } } })
  await cleanup(users, ids)
  await db.venues.deleteMany({ where: { created_by_org_id: { in: orgs } } })
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  const reviewer = await db.user.findMany({ where: { email: { startsWith: tag } }, select: { id: true } })
  await cleanup(reviewer.map((u) => u.id), [])
  await closeDb()
})

const START = new Date(Date.now() + 7 * 86_400_000)
const payload = (extra: Record<string, unknown> = {}) => ({
  title: testId("esm-event"),
  description: "integration fixture",
  start_time: START.toISOString(),
  end_time: new Date(START.getTime() + 3 * 3_600_000).toISOString(),
  timezone: "Asia/Kolkata",
  latitude: 12.9716,
  longitude: 77.5946,
  status: "draft",
  ...extra,
})

async function create(body: Record<string, unknown>) {
  const res = await eventsRoute.POST(new Request("http://localhost/api/events", { method: "POST", body: JSON.stringify(body) }) as never)
  return { status: res.status, body: (await res.json()) as { id?: string; error?: string } }
}
async function patch(id: string, body: Record<string, unknown>) {
  const res = await eventRoute.PATCH(new Request(`http://localhost/api/events/${id}`, { method: "PATCH", body: JSON.stringify(body) }), {
    params: Promise.resolve({ id }),
  })
  return { status: res.status, body: (await res.json()) as { error?: string } }
}
async function mobilePatch(userId: string, id: string, body: Record<string, unknown>) {
  const { email } = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } })
  const res = await mobileEventRoute.PATCH(
    new NextRequest(`http://localhost/api/mobile/events/${id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${signAccessToken(userId, email)}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ eventId: id }) }
  )
  return { status: res.status, body: (await res.json()) as { error?: string } }
}
const statusOf = async (id: string) => (await db.events.findUniqueOrThrow({ where: { id }, select: { status: true } })).status

describe("any organizer", () => {
  let host = ""
  beforeAll(async () => {
    host = await makeUser("esm_host", "organizer")
    users.push(host)
    const org = await db.organisations.create({ data: { kind: "company", display_name: `${tag} org`, status: "verified" } })
    orgs.push(org.id)
    await db.organisation_members.create({ data: { org_id: org.id, user_id: host, role: "owner", is_primary_contact: true } })
  })
  beforeEach(() => mockGetAuth.mockResolvedValue({ user: { id: host, role: "organizer" } }))

  it("cannot create an event already cancelled or completed", async () => {
    for (const status of ["cancelled", "completed"]) {
      const res = await create(payload({ status }))
      expect([res.status, res.body.error]).toEqual([400, CREATE_STATUS_REFUSAL])
    }
  })

  it("cannot cancel or complete a draft, through either door", async () => {
    const { body } = await create(payload())
    const id = body.id!
    expect(await patch(id, payload({ status: "cancelled" }))).toEqual({ status: 400, body: expect.objectContaining({ error: CANCEL_DRAFT_REFUSAL }) })
    expect((await patch(id, payload({ status: "completed" }))).status).toBe(400)
    expect((await mobilePatch(host, id, { status: "cancelled" })).status).toBe(400)
    expect((await mobilePatch(host, id, { status: "completed" })).status).toBe(400)
    expect(await statusOf(id)).toBe("draft")
  })

  it("still publishes a draft, unpublishes it, publishes again and cancels it; never completes it", async () => {
    const { body } = await create(payload())
    const id = body.id!
    expect((await patch(id, payload({ status: "published" }))).status).toBe(200)
    expect((await patch(id, payload({ status: "published", title: "Same status, an edit" }))).status).toBe(200)
    expect((await patch(id, payload({ status: "draft" }))).status).toBe(200)
    expect((await patch(id, payload({ status: "published" }))).status).toBe(200)
    expect(await patch(id, payload({ status: "completed" }))).toEqual({ status: 400, body: expect.objectContaining({ error: COMPLETED_REFUSAL }) })
    expect((await patch(id, payload({ status: "cancelled" }))).status).toBe(200)
    expect(await statusOf(id)).toBe("cancelled")
  })

  it("creates an event published straight away, through the publish checks", async () => {
    const res = await create(payload({ status: "published" }))
    expect(res.status).toBe(200)
    expect(await statusOf(res.body.id!)).toBe("published")
  })
})

describe("Razorpay's review organisation", () => {
  let reviewer = ""
  let orgId = ""
  let eventId = ""
  beforeAll(async () => {
    const seeded = await ensureRazorpayReviewAccount(
      db,
      "Rzp-Review-Correct-Horse-26",
      { email: `${tag}-reviewer@itest.invalid`, orgName: `${tag} review org` },
      { DATABASE_URL: "postgresql://postgres:postgres@localhost:55433/blendn_test" },
      { production: false }
    )
    reviewer = seeded.userId
    orgId = seeded.orgId
    eventId = seeded.eventId
    orgs.push(orgId)
  })
  beforeEach(() => mockGetAuth.mockResolvedValue({ user: { id: reviewer, role: "organizer" } }))

  it("may save drafts", async () => {
    const res = await create(payload())
    expect(res.status).toBe(200)
    expect((await patch(res.body.id!, payload({ title: "A draft edit" }))).status).toBe(200)
  })

  it("is refused out of draft at POST, both PATCHes, and a venue link", async () => {
    expect(await create(payload({ status: "published" }))).toEqual({ status: 403, body: { error: REVIEW_ORG_REFUSAL } })
    expect((await patch(eventId, payload({ status: "published" }))).status).toBe(403)
    expect((await mobilePatch(reviewer, eventId, { status: "published" })).status).toBe(403)
    const venue = await db.venues.create({ data: { name: `${tag} real venue` } })
    try {
      expect((await patch(eventId, payload({ venue_id: venue.id }))).status).toBe(403)
    } finally {
      await db.venues.delete({ where: { id: venue.id } })
    }
    expect(await statusOf(eventId)).toBe("draft")
    expect(await db.events.count({ where: { organizer_org_id: orgId, status: { not: "draft" } } })).toBe(0)
  })

  it("is refused a venue, an invite and a claim", async () => {
    await expect(createVenue({ name: `${tag} new venue`, venueType: null, lat: 12.97, lng: 77.59 })).rejects.toThrow(REVIEW_ORG_REFUSAL)
    await expect(inviteMember(orgId, `${tag}-friend@itest.invalid`, "staff")).rejects.toThrow(REVIEW_ORG_REFUSAL)
    const claim = await fileEventClaim({ eventId, contactEmail: `${tag}-reviewer@itest.invalid`, contactName: "R", role: "organizer" } as never)
    expect(claim).toEqual({ ok: false, error: REVIEW_ORG_REFUSAL })
    expect(await db.venues.count({ where: { created_by_org_id: orgId } })).toBe(0)
    expect(await db.organisation_invites.count({ where: { org_id: orgId } })).toBe(0)
  })
})
