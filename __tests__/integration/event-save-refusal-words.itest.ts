/*
 * The event routes refuse in words the editor can show (SCRUM-315).
 *
 * The editor now shows `refusalText(response, "Failed to save event")` for a
 * refused save. That is only as good as the shape the routes answer with: a
 * route that moved to `{ error: { message } }` would quietly bring back the
 * generic line. So the real handlers are called with real rows, and their
 * answers are read the way the editor reads them. Capacity 0 is the refusal
 * driven on staging; the no-organisation 400 is daniel.weber@'s (SCRUM-251).
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
const mockGetAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: () => mockGetAuth() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
import { refusalText } from "@/lib/refusal"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"
// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventRoute = require("@/app/api/events/[id]/route") as typeof import("@/app/api/events/[id]/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventsRoute = require("@/app/api/events/route") as typeof import("@/app/api/events/route")

const FALLBACK = "Failed to save event"
const users: string[] = []
const events: string[] = []
const orgs: string[] = []

afterAll(async () => {
  await db.events.deleteMany({ where: { id: { in: events } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await cleanup(users, [])
  await closeDb()
})

function body(extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    title: testId("esr-event"),
    description: "integration fixture",
    start_time: new Date(Date.now() + 86_400_000).toISOString(),
    end_time: new Date(Date.now() + 90_000_000).toISOString(),
    timezone: "Asia/Kolkata",
    ...extra,
  })
}

it("PATCH answers capacity 0 with a sentence the editor shows as it is", async () => {
  const host = await makeUser(testId("esr-host"), "organizer")
  users.push(host)
  const org = await db.organisations.create({ data: { kind: "company", display_name: testId("esr-org"), status: "verified" } })
  orgs.push(org.id)
  await db.organisation_members.create({ data: { org_id: org.id, user_id: host, role: "owner", is_primary_contact: true } })
  const eventId = await makeEvent(host)
  events.push(eventId)
  await db.events.update({ where: { id: eventId }, data: { organizer_org_id: org.id, max_capacity: 50 } })
  mockGetAuth.mockResolvedValue({ user: { id: host, role: "organizer" } })

  const res = await eventRoute.PATCH(
    new Request(`http://localhost/api/events/${eventId}`, { method: "PATCH", body: body({ max_capacity: 0 }) }),
    { params: Promise.resolve({ id: eventId }) }
  )

  expect(res.status).toBe(400)
  expect(await refusalText(res, FALLBACK)).toBe("max_capacity must be a positive integer")
  expect((await db.events.findUniqueOrThrow({ where: { id: eventId } })).max_capacity).toBe(50)
})

it("POST tells an organiser with no organisation why, and writes nothing", async () => {
  const loner = await makeUser(testId("esr-loner"), "organizer")
  users.push(loner)
  mockGetAuth.mockResolvedValue({ user: { id: loner, role: "organizer" } })

  const res = await eventsRoute.POST(
    new Request("http://localhost/api/events", { method: "POST", body: body() }) as never
  )

  expect(res.status).toBe(400)
  const words = await refusalText(res, FALLBACK)
  expect(words).not.toBe(FALLBACK)
  expect(words).toMatch(/organisation/i)
  expect(await db.events.count({ where: { organizer_id: loner } })).toBe(0)
})
