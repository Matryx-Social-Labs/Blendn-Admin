/*
 * The admin's status dropdown keeps the rules the other doors keep (SCRUM-318).
 *
 * `updateEventStatus` backs Publish / Unpublish / Cancel on an organiser's and
 * a venue owner's page. It wrote `events.status` and nothing else: a cancel
 * left check-ins live (Fix #35's state) and told nobody, a publish skipped the
 * pin gate, and Publish on a cancelled event revived it. The dashboard and
 * mobile PATCH routes have refused or handled each of those for months. Real
 * rows.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
const mockGetAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: () => mockGetAuth() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
import { UNCANCEL_REFUSAL } from "@/lib/event-cancellation"
import { canPublish } from "@/lib/geofence-input"
import { refusalMessage } from "@/lib/refusal"
import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, testId } from "./helpers"
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { updateEventStatus } = require("@/lib/admin-role-actions") as typeof import("@/lib/admin-role-actions")

const users: string[] = []
const events: string[] = []

beforeAll(async () => {
  const admin = await makeUser(testId("asd-admin"), "app_admin")
  users.push(admin)
  mockGetAuth.mockResolvedValue({ user: { id: admin, role: "app_admin" } })
})

afterAll(async () => {
  await db.notifications.deleteMany({ where: { user_id: { in: users } } })
  await db.event_rsvps.deleteMany({ where: { event_id: { in: events } } })
  await db.event_check_ins.deleteMany({ where: { event_id: { in: events } } })
  await db.audit_logs.deleteMany({ where: { resource_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
})

async function event(label: string, data: Record<string, unknown>) {
  const host = await makeUser(testId(`${label}-host`), "organizer")
  users.push(host)
  const id = await makeEvent(host)
  events.push(id)
  await db.events.update({ where: { id }, data })
  return id
}

/**
 * The sentence the dropdown's toast will show, read the way the client reads it.
 *
 * In production Next replaces a server action's error message before it
 * reaches the browser; only `digest` survives, which is why `Refusal` carries
 * the sentence there. Called in-process, a plain `Error` would read the same
 * through `refusalMessage`'s message fallback, so the digest is asserted too.
 */
async function refused(call: Promise<unknown>) {
  try {
    await call
  } catch (err) {
    expect((err as { digest?: unknown }).digest).toEqual(expect.stringMatching(/^refusal:/))
    return refusalMessage(err, "Failed to update event status")
  }
  return null
}

/** A refused call writes nothing, the audit row included. `auditLog` is fire-and-forget. */
async function noAuditRow(id: string) {
  await new Promise((r) => setTimeout(r, 300))
  expect(await db.audit_logs.count({ where: { resource: "event", resource_id: id } })).toBe(0)
}

it("a cancel closes the live check-ins and tells the person going", async () => {
  const id = await event("asd-cancel", { status: "published", latitude: 12.97, longitude: 77.59 })
  const guest = await makeUser(testId("asd-guest"))
  users.push(guest)
  await db.event_rsvps.create({ data: { event_id: id, user_id: guest, status: "going" } })
  await db.event_check_ins.create({
    data: { event_id: id, occurrence_id: await occurrenceOf(id), user_id: guest, status: "checked_in", check_in_time: new Date() },
  })

  await updateEventStatus(id, "cancelled")

  expect((await db.events.findUniqueOrThrow({ where: { id } })).status).toBe("cancelled")
  expect(await db.event_check_ins.count({ where: { event_id: id, status: { in: ["pending", "checked_in"] } } })).toBe(0)
  const told = await db.notifications.findMany({ where: { user_id: guest }, select: { body: true } })
  expect(told.map((n) => n.body)).toContain("This event has been cancelled")
})

it("refuses to publish a cancelled event, with the same sentence as the other doors", async () => {
  const id = await event("asd-revive", { status: "cancelled", latitude: 12.97, longitude: 77.59 })
  expect(await refused(updateEventStatus(id, "published"))).toBe(UNCANCEL_REFUSAL)
  expect((await db.events.findUniqueOrThrow({ where: { id } })).status).toBe("cancelled")
  await noAuditRow(id)
})

it("refuses to publish an event with no pin, and says why", async () => {
  const id = await event("asd-nopin", { status: "draft", latitude: null, longitude: null, geofence: null })
  const expected = canPublish({ latitude: null, longitude: null, geofence: null }).reason
  expect(expected).toBeTruthy()
  expect(await refused(updateEventStatus(id, "published"))).toBe(expected)
  expect((await db.events.findUniqueOrThrow({ where: { id } })).status).toBe("draft")
  await noAuditRow(id)
})
