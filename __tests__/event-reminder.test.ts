/*
 * "Starting in about an hour" (SCRUM-1274). The sweep sends it 60–75 minutes
 * ahead, so "~60 minutes" was a promise it did not keep; and it went to the
 * waitlisted and to people who only saved the event, in the same words as to
 * people going. A waitlisted person has no seat to leave the house for, and a
 * save is one tap on a card.
 */
const mockDb = {
  events: { findMany: jest.fn(), updateMany: jest.fn() },
  event_rsvps: { findMany: jest.fn() },
  event_favorites: { findMany: jest.fn() },
  notifications: { createManyAndReturn: jest.fn() },
  push_tokens: { findMany: jest.fn() },
}
jest.mock("@/lib/db", () => ({ db: mockDb }))

const sent: Array<{ to: string; title: string; body: string }> = []
jest.mock("expo-server-sdk", () => ({
  Expo: class {
    static isExpoPushToken() {
      return true
    }
    chunkPushNotifications(m: unknown[]) {
      return [m]
    }
    async sendPushNotificationsAsync(chunk: Array<{ to: string; title: string; body: string }>) {
      sent.push(...chunk)
      return chunk.map(() => ({ status: "ok" }))
    }
  },
}))

import { notifyEventCancelled, sendEventReminders } from "@/lib/services/event-notifications.service"

const EVENT = { id: "e0000000-0000-4000-8000-0000000000aa", title: "Quiz at Toit", start_time: new Date(), venue_name: "Toit" }
const RSVPS = [
  { user_id: "going", status: "going" },
  { user_id: "maybe", status: "maybe" },
  { user_id: "waitlisted", status: "waitlisted" },
]

beforeEach(() => {
  jest.clearAllMocks()
  sent.length = 0
  mockDb.events.findMany.mockResolvedValue([EVENT])
  mockDb.events.updateMany.mockResolvedValue({ count: 1 })
  // Answer the status filter the way the database would.
  mockDb.event_rsvps.findMany.mockImplementation(async (args: { where: { status?: { in: string[] } } }) =>
    RSVPS.filter((r) => !args.where.status || args.where.status.in.includes(r.status))
  )
  mockDb.event_favorites.findMany.mockResolvedValue([{ user_id: "saved" }, { user_id: "going" }])
  mockDb.notifications.createManyAndReturn.mockResolvedValue([])
  mockDb.push_tokens.findMany.mockImplementation(async (args: { where: { user_id: { in: string[] } } }) =>
    args.where.user_id.in.map((user_id) => ({ user_id, token: `ExponentPushToken[${user_id}]` }))
  )
})

describe("sendEventReminders", () => {
  it("reminds the people going and maybe, not the waitlisted or saved-only", async () => {
    expect(await sendEventReminders(60)).toBe(2)
    const rows = mockDb.notifications.createManyAndReturn.mock.calls.flatMap(([a]) => a.data)
    expect(rows.map((r: { user_id: string }) => r.user_id).sort()).toEqual(["going", "maybe"])
    expect(sent.map((m) => m.to).sort()).toEqual(["ExponentPushToken[going]", "ExponentPushToken[maybe]"])
  })

  it("says about an hour, with the venue, and kind event_update", async () => {
    await sendEventReminders(60)
    const rows = mockDb.notifications.createManyAndReturn.mock.calls.flatMap(([a]) => a.data)
    for (const r of rows) {
      expect(r.kind).toBe("event_update")
      expect(r.body).toBe("Starting in about an hour at Toit")
    }
    for (const m of sent) expect(m.body).toBe("Starting in about an hour at Toit")
  })

  it("leaves the venue part out when there is none", async () => {
    mockDb.events.findMany.mockResolvedValue([{ ...EVENT, venue_name: null }])
    await sendEventReminders(60)
    for (const m of sent) expect(m.body).toBe("Starting in about an hour")
  })
})

/* Splitting maybe out of `others` must not change who hears a change: maybe keeps event_update. */
describe("a cancellation, after maybe was split out", () => {
  const rows = () =>
    mockDb.notifications.createManyAndReturn.mock.calls
      .flatMap(([a]) => a.data)
      .map((r: { user_id: string; kind: string }) => `${r.user_id}:${r.kind}`)
      .sort()

  it("going get event_changed; maybe, waitlisted and saved get event_update, once each", async () => {
    await notifyEventCancelled(EVENT.id, EVENT.title)
    expect(rows()).toEqual(["going:event_changed", "maybe:event_update", "saved:event_update", "waitlisted:event_update"])
  })

  it("somebody already told (checked in) is not told again, maybe included", async () => {
    await notifyEventCancelled(EVENT.id, EVENT.title, ["maybe", "going"])
    expect(rows()).toEqual(["saved:event_update", "waitlisted:event_update"])
  })
})
