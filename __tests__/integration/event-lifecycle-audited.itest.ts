/*
 * An event's lifecycle leaves an audit trail (SCRUM-89, item 1).
 *
 * Driven on staging 2026-09-25 (SCRUM-245): as organizer@, two creates, two
 * publishes, four edits and two cancels — each cancel told everyone going that
 * their event was off, "This cannot be undone" — and `audit_logs` gained no
 * row. `POST /api/events` and `PATCH /api/events/[id]` called `auditLog`
 * nowhere; only DELETE did. Real handlers, real rows.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
const mockGetAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: () => mockGetAuth() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
import { NextRequest } from "next/server"
import { signAccessToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeUser, testId } from "./helpers"
// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventRoute = require("@/app/api/events/[id]/route") as typeof import("@/app/api/events/[id]/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventsRoute = require("@/app/api/events/route") as typeof import("@/app/api/events/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const adminActions = require("@/lib/admin-role-actions") as typeof import("@/lib/admin-role-actions")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mobileEventRoute = require("@/app/api/mobile/events/[eventId]/route") as typeof import("@/app/api/mobile/events/[eventId]/route")

const users: string[] = []
const orgs: string[] = []
const events: string[] = []
let host = ""

beforeAll(async () => {
  host = await makeUser(testId("ela-host"), "organizer")
  users.push(host)
  const org = await db.organisations.create({ data: { kind: "company", display_name: testId("ela-org"), status: "verified" } })
  orgs.push(org.id)
  await db.organisation_members.create({ data: { org_id: org.id, user_id: host, role: "owner", is_primary_contact: true } })
  mockGetAuth.mockResolvedValue({ user: { id: host, role: "organizer" } })
})

afterAll(async () => {
  await db.audit_logs.deleteMany({ where: { resource_id: { in: events } } })
  await db.events.deleteMany({ where: { id: { in: events } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await cleanup(users, [])
  await closeDb()
})

const START = new Date(Date.now() + 7 * 86_400_000)
function payload(extra: Record<string, unknown> = {}) {
  return {
    title: testId("ela-event"),
    description: "integration fixture",
    start_time: START.toISOString(),
    end_time: new Date(START.getTime() + 3 * 3_600_000).toISOString(),
    timezone: "Asia/Kolkata",
    latitude: 12.9716,
    longitude: 77.5946,
    status: "draft",
    ...extra,
  }
}

async function patch(id: string, body: Record<string, unknown>) {
  const res = await eventRoute.PATCH(
    new Request(`http://localhost/api/events/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) }
  )
  expect(res.status).toBe(200)
}

/** `auditLog` is fire-and-forget; wait briefly for the row it wrote. */
async function actionsFor(id: string, count: number) {
  for (let i = 0; i < 40; i++) {
    const rows = await db.audit_logs.findMany({
      where: { resource: "event", resource_id: id },
      orderBy: { created_at: "asc" },
      select: { action: true, user_id: true, details: true },
    })
    if (rows.length >= count) return rows
    await new Promise((r) => setTimeout(r, 50))
  }
  return db.audit_logs.findMany({ where: { resource: "event", resource_id: id }, select: { action: true, user_id: true, details: true } })
}

it("records create, publish, a material edit and a cancel, each by the person who did it", async () => {
  const res = await eventsRoute.POST(
    new Request("http://localhost/api/events", { method: "POST", body: JSON.stringify(payload()) }) as never
  )
  expect(res.status).toBe(200)
  const { id } = (await res.json()) as { id: string }
  events.push(id)
  expect((await actionsFor(id, 1)).map((r) => r.action)).toEqual(["event.created"])

  const base = payload()
  await patch(id, { ...base, status: "published" })
  await patch(id, {
    ...base,
    status: "published",
    start_time: new Date(START.getTime() + 3_600_000).toISOString(),
    end_time: new Date(START.getTime() + 4 * 3_600_000).toISOString(),
  })
  await patch(id, { ...base, status: "cancelled" })

  const rows = await actionsFor(id, 4)
  expect(rows.map((r) => r.action)).toEqual(["event.created", "event.published", "event.updated", "event.cancelled"])
  expect(new Set(rows.map((r) => r.user_id))).toEqual(new Set([host]))
  expect(rows[2].details).toMatchObject({ changes: expect.arrayContaining(["start time"]) })
})

it("records a publish and a delete made from the phone, marked as such", async () => {
  const res = await eventsRoute.POST(
    new Request("http://localhost/api/events", { method: "POST", body: JSON.stringify(payload()) }) as never
  )
  const { id } = (await res.json()) as { id: string }
  events.push(id)
  const { email } = await db.user.findUniqueOrThrow({ where: { id: host }, select: { email: true } })
  const auth = { authorization: `Bearer ${signAccessToken(host, email)}`, "content-type": "application/json" }
  const params = { params: Promise.resolve({ eventId: id }) }

  const published = await mobileEventRoute.PATCH(
    new NextRequest(`http://localhost/api/mobile/events/${id}`, { method: "PATCH", headers: auth, body: JSON.stringify({ status: "published" }) }),
    params
  )
  expect(published.status).toBe(200)
  const deleted = await mobileEventRoute.DELETE(
    new NextRequest(`http://localhost/api/mobile/events/${id}`, { method: "DELETE", headers: auth }),
    params
  )
  expect(deleted.status).toBe(200)

  const rows = await actionsFor(id, 3)
  expect(rows.map((r) => r.action)).toEqual(["event.created", "event.published", "delete"])
  expect(rows[1].details).toMatchObject({ via: "mobile", from: "draft", to: "published" })
  expect(rows[2].details).toMatchObject({ via: "mobile" })
})

it("records a cancel from the admin's status dropdown, the fourth door, by the admin", async () => {
  const res = await eventsRoute.POST(
    new Request("http://localhost/api/events", { method: "POST", body: JSON.stringify(payload({ status: "published" })) }) as never
  )
  const { id } = (await res.json()) as { id: string }
  events.push(id)
  const admin = await makeUser(testId("ela-admin"), "app_admin")
  users.push(admin)
  mockGetAuth.mockResolvedValue({ user: { id: admin, role: "app_admin" } })
  try {
    await adminActions.updateEventStatus(id, "cancelled")
  } finally {
    mockGetAuth.mockResolvedValue({ user: { id: host, role: "organizer" } })
  }

  const rows = await actionsFor(id, 2)
  expect(rows.map((r) => r.action)).toEqual(["event.created", "event.cancelled"])
  expect(rows[1].user_id).toBe(admin)
  expect(rows[1].details).toMatchObject({ via: "admin", from: "published", to: "cancelled" })
})
