/**
 * SCRUM-770: a reminder is claimed once (`reminded_at IS NULL`), and nothing
 * used to reset the claim when an event's start moved. A rescheduled event was
 * never reminded at its new time. Real PATCH handler, real reminder job, real rows.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
const mockGetAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: async () => { const s = await mockGetAuth(); return s?.user ? { ...s, user: { signedInAt: 0, ...s.user } } : s } }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
type Msg = { to: string; body?: string }
const sentMessages: Msg[] = []
jest.mock("expo-server-sdk", () => {
  class Expo {
    static isExpoPushToken(t: string) {
      return t.startsWith("ExponentPushToken[")
    }
    chunkPushNotifications(m: unknown[]) {
      return [m]
    }
    async sendPushNotificationsAsync(chunk: Msg[]) {
      sentMessages.push(...chunk)
      return chunk.map(() => ({ status: "ok", id: "t" }))
    }
  }
  return { Expo }
})

import { sendEventReminders } from "@/lib/services/event-notifications.service"
import { cleanup, closeDb, db, makeUser, onboard, testId } from "./helpers"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const dashboardEvent = require("@/app/api/events/[id]/route") as typeof import("@/app/api/events/[id]/route")

const MIN = 60_000
const REMINDER_LEAD_MINUTES = 60
const users: string[] = []
const orgs: string[] = []
const events: string[] = []
let host = ""

const reminderPushes = () => sentMessages.filter((m) => m.body?.startsWith("Starting in"))

async function patch(id: string, body: Record<string, unknown>) {
  const res = await dashboardEvent.PATCH(
    new Request(`http://localhost/api/events/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) }
  )
  expect(res.status).toBe(200)
}

/** Published, with one person going, starting inside the reminder window. */
async function eventInWindow() {
  const start = new Date(Date.now() + (REMINDER_LEAD_MINUTES + 5) * MIN)
  const row = await db.events.create({
    data: {
      slug: testId("rem"),
      title: "Reminder fixture",
      description: "integration fixture",
      start_time: start,
      end_time: new Date(start.getTime() + 180 * MIN),
      timezone: "UTC",
      status: "published",
      visibility: "public",
      organizer_id: host,
      organizer_org_id: orgs[0],
      venue_name: "The Old Room",
      address: "1 Church St",
      latitude: 12.97,
      longitude: 77.59,
    },
  })
  events.push(row.id)
  const goer = await makeUser(testId("rem-goer"))
  users.push(goer)
  await onboard(goer)
  await db.event_rsvps.create({ data: { event_id: row.id, user_id: goer, status: "going" } })
  await db.push_tokens.create({ data: { user_id: goer, token: `ExponentPushToken[${goer}]`, platform: "android" } })
  return row
}

const remindedAt = async (id: string) => (await db.events.findUniqueOrThrow({ where: { id }, select: { reminded_at: true } })).reminded_at

beforeAll(async () => {
  host = await makeUser(testId("rem-host"), "organizer")
  users.push(host)
  await onboard(host)
  const org = await db.organisations.create({ data: { kind: "company", display_name: testId("rem-org"), status: "verified" } })
  orgs.push(org.id)
  await db.organisation_members.create({ data: { org_id: org.id, user_id: host, role: "owner", is_primary_contact: true } })
  mockGetAuth.mockResolvedValue({ user: { id: host, role: "organizer" } })
})

beforeEach(() => {
  sentMessages.length = 0
})

afterAll(async () => {
  await db.audit_logs.deleteMany({ where: { resource_id: { in: events } } })
  await db.notifications.deleteMany({ where: { user_id: { in: users } } })
  await db.push_tokens.deleteMany({ where: { user_id: { in: users } } })
  await db.event_rsvps.deleteMany({ where: { event_id: { in: events } } })
  await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await db.organisation_members.deleteMany({ where: { org_id: { in: orgs } } })
  await db.organisations.deleteMany({ where: { id: { in: orgs } } })
  await closeDb()
}, 60_000)

describe("reminder after a reschedule (SCRUM-770)", () => {
  it("an already-reminded event that is rescheduled is reminded again for the new window, exactly once", async () => {
    const event = await eventInWindow()

    await sendEventReminders(REMINDER_LEAD_MINUTES)
    expect(reminderPushes()).toHaveLength(1)
    expect(await remindedAt(event.id)).not.toBeNull()

    // Moved out of the window and back into it: a different night as far as the reminder is concerned.
    await patch(event.id, {
      start_time: new Date(event.start_time.getTime() + 5 * MIN).toISOString(),
      end_time: new Date(event.end_time.getTime() + 5 * MIN).toISOString(),
    })
    expect(await remindedAt(event.id)).toBeNull()

    sentMessages.length = 0
    await sendEventReminders(REMINDER_LEAD_MINUTES)
    expect(reminderPushes()).toHaveLength(1)

    sentMessages.length = 0
    await sendEventReminders(REMINDER_LEAD_MINUTES)
    expect(reminderPushes()).toHaveLength(0)
  })

  it("an edit that leaves start_time alone does not touch reminded_at", async () => {
    const event = await eventInWindow()
    await sendEventReminders(REMINDER_LEAD_MINUTES)
    const reminded = await remindedAt(event.id)
    expect(reminded).not.toBeNull()

    await patch(event.id, { title: "A new title" })
    expect(await remindedAt(event.id)).toEqual(reminded)

    // Re-sending the same start_time (a form posting every field) is not a reschedule either.
    await patch(event.id, { title: "Another title", start_time: event.start_time.toISOString() })
    expect(await remindedAt(event.id)).toEqual(reminded)

    sentMessages.length = 0
    await sendEventReminders(REMINDER_LEAD_MINUTES)
    expect(reminderPushes()).toHaveLength(0)
  })
})
