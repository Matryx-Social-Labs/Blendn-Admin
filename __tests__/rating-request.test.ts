/*
 * "The event ended — rate who you met." Once per event.
 *
 * `sendRatingRequests` runs every five minutes on a timer in the server
 * process, and every way it can be wrong is silent: a double claim sends the
 * whole room the same push twice, a missing lookback sends every night the
 * platform has ever held on the day it ships, and a block ignored prompts
 * somebody to rate a person they blocked.
 */
const mockDb = {
  events: { findMany: jest.fn(), updateMany: jest.fn() },
  event_check_ins: { findMany: jest.fn() },
  event_likes: { findMany: jest.fn() },
  blocked_users: { findMany: jest.fn() },
  event_ratings: { findMany: jest.fn() },
  notifications: { createMany: jest.fn() },
  push_tokens: { findMany: jest.fn() },
}
jest.mock("@/lib/db", () => ({ db: mockDb }))

const sent: Array<{ to: string; body: string; data: Record<string, unknown> }> = []
jest.mock("expo-server-sdk", () => ({
  Expo: class {
    static isExpoPushToken() {
      return true
    }
    chunkPushNotifications(m: unknown[]) {
      return [m]
    }
    async sendPushNotificationsAsync(chunk: Array<{ to: string; body: string; data: Record<string, unknown> }>) {
      sent.push(...chunk)
      return chunk.map(() => ({ status: "ok" }))
    }
  },
}))

import { readFileSync } from "fs"
import { join } from "path"
import {
  RATING_REQUEST_COPY,
  RATING_REQUEST_LOOKBACK_MS,
  rateRequestAudience,
  sendRatingRequests,
} from "@/lib/services/event-notifications.service"

const EVENT = { id: "e0000000-0000-4000-8000-000000000001", title: "Friday at Toit" }
const NOW = new Date("2026-09-28T22:05:00Z")

/** A, B liked each other; C and D liked each other but C blocked D; E came alone; F opted out of push. */
function world() {
  mockDb.events.findMany.mockResolvedValue([EVENT])
  mockDb.events.updateMany.mockResolvedValue({ count: 1 })
  mockDb.event_check_ins.findMany.mockResolvedValue(["A", "B", "C", "D", "E", "F"].map((user_id) => ({ user_id })))
  mockDb.event_likes.findMany.mockResolvedValue([
    { liker_id: "A", liked_id: "B" },
    { liker_id: "B", liked_id: "A" },
    { liker_id: "C", liked_id: "D" },
    { liker_id: "D", liked_id: "C" },
    { liker_id: "E", liked_id: "A" }, // one-way: not a connection
  ])
  mockDb.blocked_users.findMany.mockResolvedValue([{ blocker_id: "C", blocked_id: "D" }])
  mockDb.event_ratings.findMany.mockResolvedValue([])
  mockDb.notifications.createMany.mockResolvedValue({ count: 0 })
  // The token query carries the push_enabled rule (NOT_OPTED_OUT); emulate the
  // database answering it: F turned notifications off, so F has no row back.
  mockDb.push_tokens.findMany.mockImplementation(async (args: { where: { user_id: { in: string[] } } }) =>
    args.where.user_id.in.filter((id) => id !== "F").map((user_id) => ({ user_id, token: `ExponentPushToken[${user_id}]` }))
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  sent.length = 0
  world()
})

describe("who is asked, and with which words", () => {
  it("separates people with somebody to rate from people with only the night", async () => {
    const audience = await rateRequestAudience(EVENT.id)
    expect(audience.withPeers.sort()).toEqual(["A", "B"])
    // C and D liked each other, but a block either way removes the connection.
    expect(audience.eventOnly.sort()).toEqual(["C", "D", "E", "F"])
  })

  it("counts attendance, not presence, and leaves out deleted and suspended accounts", async () => {
    await rateRequestAudience(EVENT.id)
    const args = mockDb.event_check_ins.findMany.mock.calls[0][0]
    expect(args.where).toEqual({ event_id: EVENT.id, user: { deletedAt: null, suspended_at: null } })
    // No `status: "checked_in"`: by the end most people have been checked out.
    expect(JSON.stringify(args.where)).not.toContain("checked_in")
    expect(args.distinct).toEqual(["user_id"])
  })

  it("does not ask somebody who already rated the night and has nobody to rate", async () => {
    mockDb.event_ratings.findMany.mockResolvedValue([{ user_id: "E" }, { user_id: "A" }])
    const audience = await rateRequestAudience(EVENT.id)
    expect(audience.eventOnly).not.toContain("E")
    // A still has B to rate, so A is still asked.
    expect(audience.withPeers).toContain("A")
  })
})

describe("sendRatingRequests", () => {
  it("pushes rating_request with the eventId — the type the app routes to /rate/[eventId]", async () => {
    const notified = await sendRatingRequests(NOW)
    expect(notified).toBe(6)

    for (const m of sent) expect(m.data).toMatchObject({ type: "rating_request", eventId: EVENT.id })
    const byUser = new Map(sent.map((m) => [m.to, m.body]))
    expect(byUser.get("ExponentPushToken[A]")).toBe(RATING_REQUEST_COPY.peers)
    expect(byUser.get("ExponentPushToken[C]")).toBe(RATING_REQUEST_COPY.event)
    expect(byUser.get("ExponentPushToken[E]")).toBe(RATING_REQUEST_COPY.event)
  })

  it("respects push_enabled: the token query excludes opt-outs, and no push reaches them", async () => {
    await sendRatingRequests(NOW)
    for (const [args] of mockDb.push_tokens.findMany.mock.calls) {
      expect(args.where).toMatchObject({ NOT: { user: { profile: { is: { push_enabled: false } } } } })
    }
    expect(sent.map((m) => m.to)).not.toContain("ExponentPushToken[F]")
  })

  it("still writes everyone a bell row, as every other kind does", async () => {
    await sendRatingRequests(NOW)
    const rows = mockDb.notifications.createMany.mock.calls.flatMap(([a]) => a.data)
    expect(rows.map((r: { user_id: string }) => r.user_id).sort()).toEqual(["A", "B", "C", "D", "E", "F"])
    for (const r of rows) expect(r.kind).toBe("rating_request")
  })

  it("claims the event before sending, so exactly one pass or replica sends", async () => {
    await sendRatingRequests(NOW)
    expect(mockDb.events.updateMany).toHaveBeenCalledWith({
      where: { id: EVENT.id, rating_requested_at: null },
      data: { rating_requested_at: NOW },
    })
    const claim = mockDb.events.updateMany.mock.invocationCallOrder[0]
    const audience = mockDb.event_check_ins.findMany.mock.invocationCallOrder[0]
    expect(claim).toBeLessThan(audience)
  })

  it("sends nothing when another pass already claimed the event", async () => {
    mockDb.events.updateMany.mockResolvedValue({ count: 0 })
    expect(await sendRatingRequests(NOW)).toBe(0)
    expect(sent).toHaveLength(0)
    expect(mockDb.notifications.createMany).not.toHaveBeenCalled()
  })

  it("only selects events that ended within the lookback and were never asked", async () => {
    await sendRatingRequests(NOW)
    const where = mockDb.events.findMany.mock.calls[0][0].where
    expect(where).toMatchObject({
      deleted_at: null,
      rating_requested_at: null,
      status: { in: ["published", "completed"] },
      end_time: { lte: NOW, gt: new Date(NOW.getTime() - RATING_REQUEST_LOOKBACK_MS) },
    })
  })

  it("never throws: a failing query is logged and the pass returns 0", async () => {
    mockDb.events.findMany.mockRejectedValue(new Error("db down"))
    await expect(sendRatingRequests(NOW)).resolves.toBe(0)
  })
})

describe("it is reachable", () => {
  const code = (rel: string) =>
    readFileSync(join(__dirname, "..", rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")

  it("runs on the reminder sweeper every server starts, and on the cron route", () => {
    // The reminder shipped with a cron route and nothing calling it; this one must not.
    expect(code("lib/reminder-sweeper.ts")).toMatch(/await sendRatingRequests\(\)/)
    expect(code("lib/background.ts")).toMatch(/startReminderSweeper\(\)/)
    expect(code("app/api/cron/event-reminders/route.ts")).toMatch(/await sendRatingRequests\(\)/)
  })

  it("the lookback bounds the first pass after deploy to hours, not the whole history", () => {
    expect(RATING_REQUEST_LOOKBACK_MS).toBeLessThanOrEqual(24 * 60 * 60 * 1000)
  })
})
