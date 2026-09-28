process.env.MOBILE_JWT_SECRET = "test-secret-at-least-32-characters-long!!"

/*
 * Leaving, muting and reporting a room — the three things a member does to a
 * room for themselves (`app/api/mobile/chat/groups/[chatGroupId]/…`).
 *
 * Each rule here fails silently if it breaks: nothing throws, the phone gets a
 * 200, and the person who left is still in the room, or the room that was
 * muted still rings, or the report lands nowhere a human looks.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

const mockDb = {
  chat_groups: { findUnique: jest.fn() },
  chat_group_members: { findUnique: jest.fn(), updateMany: jest.fn(), update: jest.fn() },
  event_reports: { create: jest.fn() },
}
jest.mock("@/lib/db", () => ({ db: mockDb }))

const mockAuth = jest.fn()
jest.mock("@/lib/mobile-auth", () => ({ getAuthenticatedUser: (...a: unknown[]) => mockAuth(...a) }))

const mockBlocks = jest.fn()
jest.mock("@/lib/conversations", () => ({ blockCounterparties: (...a: unknown[]) => mockBlocks(...a) }))

const mockLeftEmit = jest.fn()
jest.mock("@/lib/socket-server", () => ({ emitChatMemberLeft: (...a: unknown[]) => mockLeftEmit(...a) }))

import { NextRequest } from "next/server"
import * as leave from "@/app/api/mobile/chat/groups/[chatGroupId]/leave/route"
import * as mute from "@/app/api/mobile/chat/groups/[chatGroupId]/mute/route"
import * as report from "@/app/api/mobile/chat/groups/[chatGroupId]/report/route"

const ROOM = "c0000000-0000-4000-8000-000000000001"
const EVENT = "e0000000-0000-4000-8000-000000000001"
const ME = "user_me"
const HOUR = 60 * 60 * 1000

type Handler = (req: NextRequest, ctx: { params: Promise<{ chatGroupId: string }> }) => Promise<Response>

async function call(handler: Handler, method: string, opts: { body?: unknown; room?: string; raw?: string } = {}) {
  const room = opts.room ?? ROOM
  const res = await handler(
    new NextRequest(`https://api.blendn.app/api/mobile/chat/groups/${room}/x`, {
      method,
      headers: { "content-type": "application/json" },
      ...(opts.raw !== undefined ? { body: opts.raw } : opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    }),
    { params: Promise.resolve({ chatGroupId: room }) }
  )
  return { status: res.status, json: await res.json() }
}

const openEvent = () => ({
  start_time: new Date(Date.now() - 2 * HOUR),
  end_time: new Date(Date.now() + 2 * HOUR),
  status: "published",
  deleted_at: null as Date | null,
})

let membership: Record<string, unknown> | null
let group: Record<string, unknown> | null

beforeEach(() => {
  jest.clearAllMocks()
  mockAuth.mockResolvedValue({ userId: ME, email: "me@b.com" })
  mockBlocks.mockResolvedValue(["user_blocked"])
  group = { id: ROOM, event_id: EVENT, status: "active", event: openEvent() }
  membership = {
    id: "m1",
    status: "active",
    left_at: null,
    muted_at: null,
    banned_by: null,
    notification_preferences: {},
  }
  mockDb.chat_groups.findUnique.mockImplementation(async () => group)
  mockDb.chat_group_members.findUnique.mockImplementation(async () => membership)
  mockDb.chat_group_members.updateMany.mockResolvedValue({ count: 1 })
  mockDb.chat_group_members.update.mockResolvedValue({})
  mockDb.event_reports.create.mockResolvedValue({})
})

describe("POST /chat/groups/:id/leave", () => {
  it("marks the membership left with left_at, scoped on the statuses being left", async () => {
    const res = await call(leave.POST, "POST")
    expect(res.status).toBe(200)
    expect(res.json.data).toEqual({ chatGroupId: ROOM, left: true })

    const args = mockDb.chat_group_members.updateMany.mock.calls[0][0]
    expect(args.where).toEqual({ id: "m1", status: { in: ["active", "muted"] } })
    expect(args.data.status).toBe("left")
    expect(args.data.left_at).toBeInstanceOf(Date)
  })

  it("tells the room — minus the leaver's block counterparties — and evicts them", async () => {
    await call(leave.POST, "POST")
    expect(mockLeftEmit).toHaveBeenCalledWith(ROOM, ME, ["user_blocked"], EVENT)
  })

  it("is idempotent: a second leave changes nothing and tells nobody", async () => {
    mockDb.chat_group_members.updateMany.mockResolvedValue({ count: 0 })
    membership!.status = "left"
    membership!.left_at = new Date()
    const res = await call(leave.POST, "POST")
    expect(res.status).toBe(200)
    expect(res.json.data.left).toBe(true)
    expect(mockLeftEmit).not.toHaveBeenCalled()
  })

  it("never overwrites a ban: the update is scoped to active and muted", async () => {
    membership!.status = "banned"
    mockDb.chat_group_members.updateMany.mockResolvedValue({ count: 0 })
    const res = await call(leave.POST, "POST")
    expect(res.status).toBe(200)
    expect(mockLeftEmit).not.toHaveBeenCalled()
  })

  it("still evicts, and tells nobody, when blocks cannot be read", async () => {
    mockBlocks.mockRejectedValue(new Error("db down"))
    await call(leave.POST, "POST")
    // Null exclusions = eviction only (see emitChatMemberLeft).
    expect(mockLeftEmit).toHaveBeenCalledWith(ROOM, ME, null, EVENT)
  })

  it.each([
    ["a malformed id", () => undefined, "not-a-uuid"],
    ["an unknown room", () => (group = null), ROOM],
    ["a room you are not in", () => (membership = null), ROOM],
    ["a draft event's room", () => ((group!.event as { status: string }).status = "draft"), ROOM],
  ])("answers one 404 NOT_FOUND for %s", async (_label, arrange, room) => {
    arrange()
    const res = await call(leave.POST, "POST", { room })
    expect(res.status).toBe(404)
    expect(res.json.errorCode).toBe("NOT_FOUND")
    expect(mockDb.chat_group_members.updateMany).not.toHaveBeenCalled()
  })

  it("401s without a token", async () => {
    mockAuth.mockResolvedValue(null)
    expect((await call(leave.POST, "POST")).status).toBe(401)
  })
})

describe("DELETE /chat/groups/:id/leave — rejoin", () => {
  it("rejoins somebody who left by choice, and clears left_at", async () => {
    membership!.status = "left"
    membership!.left_at = new Date()
    const res = await call(leave.DELETE, "DELETE")
    expect(res.status).toBe(200)
    expect(res.json.data).toEqual({ chatGroupId: ROOM, left: false })
    const args = mockDb.chat_group_members.updateMany.mock.calls[0][0]
    expect(args.where).toMatchObject({ id: "m1", status: "left", left_at: { not: null } })
    expect(args.data).toMatchObject({ status: "active", left_at: null })
  })

  it("brings back a moderation mute: leaving is not a way out of one", async () => {
    membership!.status = "left"
    membership!.left_at = new Date()
    membership!.muted_at = new Date()
    await call(leave.DELETE, "DELETE")
    expect(mockDb.chat_group_members.updateMany.mock.calls[0][0].data.status).toBe("muted")
  })

  it("is idempotent for somebody who never left", async () => {
    const res = await call(leave.DELETE, "DELETE")
    expect(res.status).toBe(200)
    expect(res.json.data.left).toBe(false)
    expect(mockDb.chat_group_members.updateMany).not.toHaveBeenCalled()
  })

  it("cannot lift a ban", async () => {
    membership!.status = "banned"
    membership!.banned_by = "org_1"
    const res = await call(leave.DELETE, "DELETE")
    expect(res.status).toBe(403)
    expect(res.json.errorCode).toBe("USER_BANNED")
  })

  it("cannot reopen a room the sweeper released (left, no left_at)", async () => {
    membership!.status = "left"
    const res = await call(leave.DELETE, "DELETE")
    expect(res.status).toBe(403)
    expect(res.json.errorCode).toBe("CHAT_CLOSED")
  })

  it("cannot reopen a room whose window has shut", async () => {
    membership!.status = "left"
    membership!.left_at = new Date()
    group!.event = { ...openEvent(), end_time: new Date(Date.now() - 48 * HOUR), start_time: new Date(Date.now() - 50 * HOUR) }
    const res = await call(leave.DELETE, "DELETE")
    expect(res.status).toBe(403)
    expect(res.json.errorCode).toBe("CHAT_CLOSED")
  })
})

describe("POST/DELETE /chat/groups/:id/mute", () => {
  it("mutes until turned off, keeping every other preference", async () => {
    membership!.notification_preferences = { something_else: 1 }
    const res = await call(mute.POST, "POST")
    expect(res.status).toBe(200)
    expect(res.json.data).toEqual({ chatGroupId: ROOM, mute: { muted: true, until: null } })
    expect(mockDb.chat_group_members.update.mock.calls[0][0].data.notification_preferences).toEqual({
      something_else: 1,
      muted: true,
      muted_until: null,
    })
  })

  it("mutes until a time", async () => {
    const until = new Date(Date.now() + 8 * HOUR).toISOString()
    const res = await call(mute.POST, "POST", { body: { until } })
    expect(res.json.data.mute).toEqual({ muted: true, until })
  })

  it.each([
    ["in the past", { until: new Date(Date.now() - HOUR).toISOString() }],
    ["more than a year away", { until: new Date(Date.now() + 400 * 24 * HOUR).toISOString() }],
    ["not a time", { until: "tomorrow" }],
  ])("refuses an until %s", async (_l, body) => {
    const res = await call(mute.POST, "POST", { body })
    expect(res.status).toBe(400)
    expect(res.json.errorCode).toBe("VALIDATION_FAILED")
    expect(mockDb.chat_group_members.update).not.toHaveBeenCalled()
  })

  it("unmutes idempotently, removing only the mute keys", async () => {
    membership!.notification_preferences = { something_else: 1, muted: true, muted_until: null }
    const res = await call(mute.DELETE, "DELETE")
    expect(res.status).toBe(200)
    expect(res.json.data.mute).toEqual({ muted: false, until: null })
    expect(mockDb.chat_group_members.update.mock.calls[0][0].data.notification_preferences).toEqual({
      something_else: 1,
    })
  })

  it("404s a room you are not in", async () => {
    membership = null
    const res = await call(mute.POST, "POST")
    expect(res.status).toBe(404)
    expect(res.json.errorCode).toBe("NOT_FOUND")
  })
})

describe("POST /chat/groups/:id/report", () => {
  it("files an event report that names the room", async () => {
    const res = await call(report.POST, "POST", { body: { reason: "harassment", description: "pile-on" } })
    expect(res.status).toBe(201)
    expect(res.json.data).toEqual({ reported: true })
    expect(mockDb.event_reports.create).toHaveBeenCalledWith({
      data: { event_id: EVENT, chat_group_id: ROOM, user_id: ME, reason: "harassment", description: "pile-on" },
    })
  })

  it("accepts a report without a description (no explicit undefined)", async () => {
    await call(report.POST, "POST", { body: { reason: "spam" } })
    expect(mockDb.event_reports.create.mock.calls[0][0].data).not.toHaveProperty("description")
  })

  it("lets somebody who left, or was banned, report the room", async () => {
    membership!.status = "banned"
    expect((await call(report.POST, "POST", { body: { reason: "x" } })).status).toBe(201)
    membership!.status = "left"
    membership!.left_at = new Date()
    expect((await call(report.POST, "POST", { body: { reason: "x" } })).status).toBe(201)
  })

  it("keeps a room whose event was taken down reportable", async () => {
    ;(group!.event as { deleted_at: Date | null }).deleted_at = new Date()
    expect((await call(report.POST, "POST", { body: { reason: "x" } })).status).toBe(201)
  })

  it("404s a room you were never in", async () => {
    membership = null
    const res = await call(report.POST, "POST", { body: { reason: "x" } })
    expect(res.status).toBe(404)
    expect(res.json.errorCode).toBe("NOT_FOUND")
    expect(mockDb.event_reports.create).not.toHaveBeenCalled()
  })

  it("requires a reason", async () => {
    const res = await call(report.POST, "POST", { body: { reason: "  " } })
    expect(res.status).toBe(400)
  })
})
