/**
 * Quiet hours, 23:00-09:00 on the recipient's clock (launch gate 7, SCRUM-1276): held, not dropped.
 *
 * A 2 a.m. match is how people end up switching `push_enabled` off, which also kills the pushes that matter. So a
 * push that is not about tonight waits in the bell (`held_until`) and rings once at 09:00. Somebody out tonight is
 * never muted: a DM, a crew arrival, a safety notice, anything about an event they are going to or at, and anything
 * at all for a person with an open check-in rings at any hour.
 */
type Where = Record<string, unknown>
type CheckIn = { user_id: string; event_id: string; status: string }

const EVENT = "e0000000-0000-4000-8000-000000000001"
const STARTED_EVENT = "e0000000-0000-4000-8000-000000000002"
const CLOSED_CHAT = "c0000000-0000-4000-8000-000000000009"

const world = {
  homes: new Map<string, string>(),
  checkIns: [] as CheckIn[],
  going: new Set<string>(),
  events: new Map<string, { timezone: string; start_time: Date }>(),
  closed: new Set<string>(),
}

const ids = (where: Where, key: string) => ((where[key] as { in?: string[] } | undefined)?.in ?? null)
const matchesCheckIn = (row: CheckIn, clause: Where) =>
  Object.entries(clause).every(([k, v]) => row[k as keyof CheckIn] === v)

const mockDb = {
  notifications: { create: jest.fn(), createManyAndReturn: jest.fn(), updateManyAndReturn: jest.fn() },
  push_tokens: { findMany: jest.fn() },
  profiles: {
    findMany: jest.fn(async ({ where }: { where: Where }) =>
      (ids(where, "id") ?? []).map((id) => ({ id, home_city: world.homes.has(id) ? { timezone: world.homes.get(id) } : null }))
    ),
  },
  events: {
    findUnique: jest.fn(async ({ where }: { where: { id: string } }) => world.events.get(where.id) ?? null),
    findMany: jest.fn(async ({ where }: { where: Where }) =>
      (ids(where, "id") ?? []).filter((id) => {
        const e = world.events.get(id)
        return e && e.start_time <= ((where.start_time as { lte: Date }).lte)
      }).map((id) => ({ id }))
    ),
  },
  event_check_ins: {
    findMany: jest.fn(async ({ where }: { where: Where }) => {
      const users = ids(where, "user_id") ?? []
      const or = (where.OR as Where[] | undefined) ?? [{}]
      return world.checkIns.filter((c) => users.includes(c.user_id) && or.some((clause) => matchesCheckIn(c, clause))).map((c) => ({ user_id: c.user_id }))
    }),
  },
  event_rsvps: {
    findMany: jest.fn(async ({ where }: { where: Where }) =>
      (ids(where, "user_id") ?? []).filter((id) => where.event_id === EVENT && where.status === "going" && world.going.has(id)).map((user_id) => ({ user_id }))
    ),
  },
  private_conversations: {
    findMany: jest.fn(async ({ where }: { where: Where }) => (ids(where, "id") ?? []).filter((id) => world.closed.has(id)).map((id) => ({ id }))),
  },
}
jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("@/lib/badge-count", () => ({ badgeCountsFor: async (u: string[]) => new Map(u.map((id) => [id, 1])) }))

const sent: Array<{ to: string; title: string; body: string; data: Record<string, unknown> }> = []
jest.mock("expo-server-sdk", () => ({
  Expo: class {
    static isExpoPushToken() {
      return true
    }
    chunkPushNotifications(m: unknown[]) {
      return [m]
    }
    async sendPushNotificationsAsync(chunk: typeof sent) {
      sent.push(...chunk)
      return chunk.map(() => ({ status: "ok", id: "ticket" }))
    }
  },
}))

import {
  releaseHeldNotifications,
  sendBulkPushNotifications,
  sendPushNotification,
  type NotificationData,
} from "@/lib/push-notifications"

/** 01:00 IST on Fri 2026-11-27, and the 09:00 IST that follows it. */
const ONE_AM_IST = new Date("2026-11-26T19:30:00Z")
const NINE_AM_IST = new Date("2026-11-27T03:30:00Z")

const at = (now: Date) => jest.useFakeTimers({ now, doNotFake: ["setImmediate", "nextTick"] })
const tokenOf = (userId: string) => `ExponentPushToken[${userId}]`
const createdRow = () => (mockDb.notifications.create.mock.calls.at(-1)?.[0] as { data: Where } | undefined)?.data

beforeEach(() => {
  delete process.env.PUSH_QUIET_HOURS
  sent.length = 0
  world.homes = new Map()
  world.checkIns = []
  world.going = new Set()
  world.events = new Map([
    [EVENT, { timezone: "Asia/Kolkata", start_time: new Date("2026-11-28T08:30:00Z") }],
    [STARTED_EVENT, { timezone: "Asia/Kolkata", start_time: new Date("2026-11-26T14:30:00Z") }],
  ])
  world.closed = new Set()
  for (const fn of Object.values(mockDb).flatMap((t) => Object.values(t))) (fn as jest.Mock).mockClear()
  let n = 0
  mockDb.notifications.create.mockImplementation(async () => ({ id: `row-${++n}` }))
  mockDb.notifications.createManyAndReturn.mockImplementation(async ({ data }: { data: Array<{ user_id: string }> }) =>
    data.map((r) => ({ id: `row-${r.user_id}`, user_id: r.user_id }))
  )
  mockDb.push_tokens.findMany.mockImplementation(async ({ where }: { where: Where }) => {
    const users = typeof where.user_id === "string" ? [where.user_id] : (ids(where, "user_id") ?? [])
    return users.map((user_id) => ({ user_id, token: tokenOf(user_id), channel_set: 2, platform: "ios" }))
  })
})

afterEach(() => jest.useRealTimers())
// Back to what jest.config.ts sets for every suite.
afterAll(() => {
  process.env.PUSH_QUIET_HOURS = "off"
})

/** Every kind, at 01:00 IST, for somebody at home, somebody going to the event and somebody checked in elsewhere. */
const KINDS: Array<[NotificationData["type"], { eventId?: boolean }, "rings" | "held" | "dropped", "rings" | "held" | "dropped"]> = [
  // [kind, carries data.eventId, at home, going to that event]
  ["private_message", {}, "rings", "rings"],
  ["group_message", {}, "rings", "rings"],
  ["message_request", {}, "rings", "rings"],
  ["message_request_response", {}, "rings", "rings"],
  ["crew_here", {}, "rings", "rings"],
  ["report_actioned", {}, "rings", "rings"],
  ["board_post_removed", { eventId: true }, "rings", "rings"],
  ["event_update", { eventId: true }, "held", "rings"],
  ["event_changed", { eventId: true }, "held", "rings"],
  ["event_cancelled", { eventId: true }, "held", "rings"],
  ["announcement", { eventId: true }, "held", "rings"],
  ["waitlist_promoted", { eventId: true }, "held", "rings"],
  ["rating_request", { eventId: true }, "held", "rings"],
  ["board_request", { eventId: true }, "held", "rings"],
  ["board_request_accepted", { eventId: true }, "held", "rings"],
  ["board_match", { eventId: true }, "dropped", "rings"],
  ["board_host_post", { eventId: true }, "dropped", "rings"],
  ["event_checkin", {}, "dropped", "dropped"],
  ["match", {}, "held", "held"],
  ["reveal_request", {}, "held", "held"],
  ["reveal", {}, "held", "held"],
  ["friend_request", {}, "held", "held"],
  ["friend_accepted", {}, "held", "held"],
  ["crew_invite", {}, "held", "held"],
  ["blend", {}, "held", "held"],
  ["venue_offer", {}, "held", "held"],
]

async function outcome(kind: NotificationData["type"], withEvent: boolean): Promise<"rings" | "held" | "dropped"> {
  sent.length = 0
  mockDb.notifications.create.mockClear()
  await sendPushNotification({ userId: "u1", title: "t", body: "b", data: { type: kind, ...(withEvent && { eventId: EVENT }) } })
  if (sent.length > 0) return "rings"
  return createdRow()?.held_until ? "held" : "dropped"
}

describe("the decision, kind by kind, at 01:00 IST", () => {
  it("covers every kind the type names", () => {
    // A new kind must take a side here before it ships.
    const named: Record<NotificationData["type"], true> = {
      private_message: true, group_message: true, event_checkin: true, event_update: true, event_cancelled: true,
      announcement: true, message_request: true, message_request_response: true, waitlist_promoted: true, match: true,
      reveal_request: true, reveal: true, board_request: true, board_request_accepted: true, board_match: true,
      board_host_post: true, friend_request: true, friend_accepted: true, rating_request: true, crew_invite: true,
      crew_here: true, blend: true, venue_offer: true, event_changed: true, report_actioned: true, board_post_removed: true,
    }
    expect(KINDS.map(([k]) => k).sort()).toEqual(Object.keys(named).sort())
  })

  it.each(KINDS)("%s: somebody at home", async (kind, { eventId }, home) => {
    at(ONE_AM_IST)
    expect(await outcome(kind, !!eventId)).toBe(home)
  })

  it.each(KINDS)("%s: somebody going to the event, not there yet", async (kind, { eventId }, _home, going) => {
    at(ONE_AM_IST)
    world.going.add("u1")
    expect(await outcome(kind, !!eventId)).toBe(going)
  })

  it.each(KINDS)("%s: somebody checked in to the event (a row, even checked out)", async (kind, { eventId }, _home, going) => {
    at(ONE_AM_IST)
    world.checkIns.push({ user_id: "u1", event_id: EVENT, status: "checked_out" })
    expect(await outcome(kind, !!eventId)).toBe(going)
  })

  it.each(KINDS)("%s: somebody with an open check-in anywhere rings", async (kind, { eventId }) => {
    at(ONE_AM_IST)
    world.checkIns.push({ user_id: "u1", event_id: "e-elsewhere", status: "checked_in" })
    expect(await outcome(kind, !!eventId)).toBe("rings")
  })
})

describe("a match at 23:30 IST", () => {
  beforeEach(() => at(new Date("2026-11-26T18:00:00Z")))

  it("for somebody at home: a bell row held until 09:00 IST, and no push", async () => {
    const pushed = await sendPushNotification({ userId: "u1", title: "You both waved", body: "You and Fox both waved", data: { type: "match", conversationId: "c1" } })

    expect(pushed).toBe(false)
    expect(sent).toHaveLength(0)
    expect(createdRow()).toMatchObject({ user_id: "u1", kind: "match", held_until: NINE_AM_IST })
  })

  it("for somebody with an open check-in: sent, and the row is not held", async () => {
    world.checkIns.push({ user_id: "u1", event_id: "e-elsewhere", status: "checked_in" })
    const pushed = await sendPushNotification({ userId: "u1", title: "You both waved", body: "You and Fox both waved", data: { type: "match", conversationId: "c1" } })

    expect(pushed).toBe(true)
    expect(sent.map((m) => m.body)).toEqual(["You and Fox both waved"])
    expect(createdRow()?.held_until ?? null).toBeNull()
  })

  it("a DM sends, and nobody's clock or check-ins are read", async () => {
    await sendPushNotification({ userId: "u1", title: "Fox", body: "hey", data: { type: "private_message", conversationId: "c1" } })

    expect(sent).toHaveLength(1)
    expect(mockDb.profiles.findMany).not.toHaveBeenCalled()
    expect(mockDb.event_check_ins.findMany).not.toHaveBeenCalled()
  })
})

describe("the boundaries, on the recipient's clock", () => {
  it.each([
    ["22:59 IST rings", "2026-11-26T17:29:00Z", true],
    ["23:00 IST is held", "2026-11-26T17:30:00Z", false],
    ["08:59 IST is held", "2026-11-27T03:29:00Z", false],
    ["09:00 IST rings", "2026-11-27T03:30:00Z", true],
  ])("%s", async (_label, iso, rings) => {
    at(new Date(iso))
    await sendPushNotification({ userId: "u1", title: "t", body: "b", data: { type: "friend_request", requestId: "r1" } })
    expect(sent.length > 0).toBe(rings)
  })
})

describe("whose clock", () => {
  it("the event's zone when the push names an event, over the recipient's home city", async () => {
    // 01:00 IST is 14:30 in Toronto: the event's zone says quiet.
    at(ONE_AM_IST)
    world.homes.set("u1", "America/Toronto")
    await sendPushNotification({ userId: "u1", title: "t", body: "b", data: { type: "event_changed", eventId: EVENT } })
    expect(createdRow()?.held_until).toEqual(NINE_AM_IST)
  })

  it("the home city's zone when it names none", async () => {
    at(ONE_AM_IST) // 14:30 in Toronto
    world.homes.set("u1", "America/Toronto")
    await sendPushNotification({ userId: "u1", title: "t", body: "b", data: { type: "match", conversationId: "c1" } })
    expect(sent).toHaveLength(1)
  })

  it("Asia/Kolkata for somebody with no home city", async () => {
    at(ONE_AM_IST)
    await sendPushNotification({ userId: "u1", title: "t", body: "b", data: { type: "match", conversationId: "c1" } })
    expect(createdRow()?.held_until).toEqual(NINE_AM_IST)
  })

  it.each([
    // Toronto leaves daylight time at 02:00 EDT on Sun 2026-11-01 (06:00Z).
    ["23:30 EDT Sat, held to 09:00 EDT", "2026-10-31T03:30:00Z", "2026-10-31T13:00:00Z"],
    ["00:30 EDT Sun, held to 09:00 EST", "2026-11-01T04:30:00Z", "2026-11-01T14:00:00Z"],
    ["08:30 EST Sun (09:30 by the old offset), held to 09:00 EST", "2026-11-01T13:30:00Z", "2026-11-01T14:00:00Z"],
  ])("America/Toronto across the DST change: %s", async (_label, now, until) => {
    at(new Date(now))
    world.homes.set("u1", "America/Toronto")
    await sendPushNotification({ userId: "u1", title: "t", body: "b", data: { type: "crew_invite", crewId: "k1" } })
    expect(sent).toHaveLength(0)
    expect(createdRow()?.held_until).toEqual(new Date(until))
  })

  it("09:30 EST Sun rings in Toronto", async () => {
    at(new Date("2026-11-01T14:30:00Z"))
    world.homes.set("u1", "America/Toronto")
    await sendPushNotification({ userId: "u1", title: "t", body: "b", data: { type: "crew_invite", crewId: "k1" } })
    expect(sent).toHaveLength(1)
  })
})

describe("the bulk path", () => {
  it("an announcement at 01:00: the checked-in member rings, the member at home is held, in one check-in read", async () => {
    at(ONE_AM_IST)
    world.checkIns.push({ user_id: "inside", event_id: EVENT, status: "checked_in" })

    const result = await sendBulkPushNotifications({
      userIds: ["inside", "home"],
      title: "📢 Friday",
      body: "Raffle at nine",
      data: { type: "announcement", chatGroupId: "g1", eventId: EVENT },
    })

    expect(sent.map((m) => m.to)).toEqual([tokenOf("inside")])
    expect(result).toMatchObject({ sent: 1, noDevice: 0 })
    const rows = (mockDb.notifications.createManyAndReturn.mock.calls[0][0] as { data: Array<{ user_id: string; held_until: Date | null }> }).data
    expect(rows).toEqual([
      expect.objectContaining({ user_id: "inside", held_until: null }),
      expect.objectContaining({ user_id: "home", held_until: NINE_AM_IST }),
    ])
    expect(mockDb.event_check_ins.findMany).toHaveBeenCalledTimes(1)
    // The held member's devices are never looked up.
    expect(ids(mockDb.push_tokens.findMany.mock.calls[0][0].where, "user_id")).toEqual(["inside"])
  })

  it("a Lobby alert at night for somebody not going is dropped: no row, no push", async () => {
    at(ONE_AM_IST)
    await sendBulkPushNotifications({ userIds: ["home"], title: "Lobby", body: "b", data: { type: "board_match", eventId: EVENT, postId: "p1" } })
    expect(sent).toHaveLength(0)
    expect(mockDb.notifications.createManyAndReturn).not.toHaveBeenCalled()
  })
})

describe("never in the way of a send", () => {
  it("PUSH_QUIET_HOURS=off rings at 01:00", async () => {
    at(ONE_AM_IST)
    process.env.PUSH_QUIET_HOURS = "off"
    await sendPushNotification({ userId: "u1", title: "t", body: "b", data: { type: "match", conversationId: "c1" } })
    expect(sent).toHaveLength(1)
  })

  it("a held push whose bell row could not be written is sent now, never lost", async () => {
    at(ONE_AM_IST)
    mockDb.notifications.create.mockRejectedValueOnce(new Error("db busy"))
    await sendPushNotification({ userId: "u1", title: "t", body: "b", data: { type: "match", conversationId: "c1" } })
    expect(sent).toHaveLength(1)
  })

  it("the same on the bulk path: a held recipient whose chunk failed is sent now", async () => {
    at(ONE_AM_IST)
    mockDb.notifications.createManyAndReturn.mockRejectedValueOnce(new Error("db busy"))
    await sendBulkPushNotifications({ userIds: ["home"], title: "t", body: "b", data: { type: "blend", blendId: "b1" } })
    expect(sent.map((m) => m.to)).toEqual([tokenOf("home")])
  })

  it("a hold that cannot be decided is a push sent", async () => {
    at(ONE_AM_IST)
    mockDb.profiles.findMany.mockRejectedValueOnce(new Error("db busy"))
    await sendPushNotification({ userId: "u1", title: "t", body: "b", data: { type: "match", conversationId: "c1" } })
    expect(sent).toHaveLength(1)
  })
})

describe("the 09:00 release", () => {
  const held = (id: string, user_id: string, kind: string, minute: number, extra: Where = {}) => ({
    id,
    user_id,
    kind,
    title: `${kind} title`,
    body: `${kind} body`,
    data: { type: kind, ...extra },
    read_at: null as Date | null,
    created_at: new Date(Date.UTC(2026, 10, 26, 18, minute)),
  })

  beforeEach(() => at(new Date("2026-11-27T03:31:00Z")))

  it("claims only rows whose hold is over", async () => {
    mockDb.notifications.updateManyAndReturn.mockResolvedValue([])
    await releaseHeldNotifications()
    expect(mockDb.notifications.updateManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({ where: { held_until: { lte: new Date("2026-11-27T03:31:00Z") } }, data: { held_until: null } })
    )
  })

  it("three held rows are ONE push, the newest, as itself; a person who read theirs gets none", async () => {
    const read = { ...held("r-read", "b", "match", 5), read_at: new Date("2026-11-27T03:00:00Z") }
    mockDb.notifications.updateManyAndReturn.mockResolvedValue([
      held("r1", "a", "friend_request", 1, { requestId: "q1" }),
      held("r3", "a", "match", 30, { conversationId: "c1" }),
      held("r2", "a", "crew_invite", 10, { crewId: "k1" }),
      read,
    ])

    const result = await releaseHeldNotifications()

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ to: tokenOf("a"), title: "match title", body: "match body", data: { type: "match", conversationId: "c1", notificationId: "r3" } })
    expect(result).toEqual({ released: 4, pushed: 1 })
  })

  it("goes through the same device gates as a fresh send: push_enabled and the kind's own switch", async () => {
    mockDb.notifications.updateManyAndReturn.mockResolvedValue([held("r1", "a", "friend_request", 1, { requestId: "q1" })])
    await releaseHeldNotifications()
    expect(mockDb.push_tokens.findMany.mock.calls[0][0].where).toMatchObject({
      user_id: "a",
      NOT: { user: { profile: { is: { push_enabled: false } } } },
      AND: expect.arrayContaining([{ user: { NOT: { profile: { is: { push_matches: false } } } } }]),
    })
  })

  it("is never held again, at any hour", async () => {
    at(ONE_AM_IST)
    mockDb.notifications.updateManyAndReturn.mockResolvedValue([held("r1", "a", "friend_request", 1, { requestId: "q1" })])
    await releaseHeldNotifications()
    expect(sent).toHaveLength(1)
    expect(mockDb.notifications.create).not.toHaveBeenCalled()
  })

  it("skips a match whose conversation closed overnight (a block closes it) and falls to the older row", async () => {
    world.closed.add(CLOSED_CHAT)
    mockDb.notifications.updateManyAndReturn.mockResolvedValue([
      held("r1", "a", "friend_request", 1, { requestId: "q1" }),
      held("r2", "a", "match", 30, { conversationId: CLOSED_CHAT }),
    ])
    await releaseHeldNotifications()
    expect(sent.map((m) => m.data.notificationId)).toEqual(["r1"])
  })

  it("a stale check that throws after the claim still sends: the claim has already cleared the holds", async () => {
    mockDb.private_conversations.findMany.mockRejectedValueOnce(new Error("db busy"))
    mockDb.notifications.updateManyAndReturn.mockResolvedValue([held("r1", "a", "match", 1, { conversationId: "c1" })])
    await releaseHeldNotifications()
    expect(sent.map((m) => m.data.notificationId)).toEqual(["r1"])
  })

  it("a row with no kind in its data is cleared and not sent", async () => {
    mockDb.notifications.updateManyAndReturn.mockResolvedValue([{ ...held("r1", "a", "match", 1), data: null }])
    await expect(releaseHeldNotifications()).resolves.toEqual({ released: 1, pushed: 0 })
    expect(sent).toHaveLength(0)
  })

  it("skips a row about an event that has already started: a reminder would be false by now", async () => {
    mockDb.notifications.updateManyAndReturn.mockResolvedValue([held("r1", "a", "event_update", 1, { eventId: STARTED_EVENT })])
    const result = await releaseHeldNotifications()
    expect(sent).toHaveLength(0)
    expect(result).toEqual({ released: 1, pushed: 0 })
  })
})
