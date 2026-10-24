import { NextRequest } from "next/server"

/*
 * A big room refuses a send nobody could check; a small one delivers it
 * (moderation-degraded policy).
 *
 * With OpenAI down an unscreened line in a 2k concert room reaches the most
 * people at the worst moment. Past 200 inside, no verdict means no message:
 * 503 MODERATION_UNAVAILABLE, the just-written row taken back, nothing emitted.
 * A room of eight still gets its line and the re-check sweeper looks again.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

const mockCheckText = jest.fn()
jest.mock("@/lib/moderation/openai-moderation", () => ({
  ...jest.requireActual("@/lib/moderation/openai-moderation"),
  checkTextContent: (...a: unknown[]) => mockCheckText(...a),
}))
const mockHere = jest.fn()
jest.mock("@/lib/attendee-counts", () => ({
  ...jest.requireActual("@/lib/attendee-counts"),
  hereCountFor: (...a: unknown[]) => mockHere(...a),
}))
const emitted: string[] = []
jest.mock("@/lib/socket-server", () => ({
  ...jest.requireActual("@/lib/socket-server"),
  emitChatMessage: (...a: unknown[]) => void emitted.push((a[1] as { content: string }).content),
}))

import { signAccessToken } from "@/lib/mobile-auth"
import { BREAKER_FAILURES_TO_OPEN, recordTextFailure, recordTextSuccess } from "@/lib/moderation/text-breaker"
import { lastMessagesOf } from "@/lib/chat-list"
import { db, closeDb, makeUser, testId } from "./helpers"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const groupRoute = require("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route") as
  typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventRoute = require("@/app/api/mobile/events/[eventId]/chat/route") as
  typeof import("@/app/api/mobile/events/[eventId]/chat/route")

const users: string[] = []
const events: string[] = []
const HOUR = 60 * 60 * 1000

afterAll(async () => {
  if (events.length) {
    const groups = await db.chat_groups.findMany({ where: { event_id: { in: events } }, select: { id: true } })
    const groupIds = groups.map((g) => g.id)
    if (groupIds.length) {
      await db.moderation_flags.deleteMany({ where: { chat_group_id: { in: groupIds } } })
      await db.chat_messages.deleteMany({ where: { chat_group_id: { in: groupIds } } })
      await db.chat_group_members.deleteMany({ where: { chat_group_id: { in: groupIds } } })
      await db.chat_groups.deleteMany({ where: { id: { in: groupIds } } })
    }
    await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
    await db.events.deleteMany({ where: { id: { in: events } } })
  }
  if (users.length) await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

async function liveRoom() {
  const owner = await makeUser(testId("rs_own"), "organizer")
  users.push(owner)
  const now = Date.now()
  const event = await db.events.create({
    data: {
      slug: testId("rs"),
      title: `Room ${testId("t")}`,
      description: "integration fixture",
      start_time: new Date(now - HOUR),
      end_time: new Date(now + 3 * HOUR),
      timezone: "UTC",
      status: "published",
      organizer_id: owner,
    },
  })
  events.push(event.id)
  await db.event_occurrences.create({
    data: {
      event_id: event.id,
      occurs_on: new Date(event.start_time.toISOString().slice(0, 10)),
      start_time: event.start_time,
      end_time: event.end_time,
    },
  })
  const group = await db.chat_groups.create({ data: { event_id: event.id, name: "room", status: "active" } })
  const memberId = await makeUser(testId("rs_m"))
  users.push(memberId)
  const user = await db.user.findUniqueOrThrow({ where: { id: memberId }, select: { email: true } })
  await db.chat_group_members.create({
    data: { chat_group_id: group.id, user_id: memberId, anonymous_name: `Pseudo ${testId("x")}` },
  })
  return { eventId: event.id, groupId: group.id, memberId, token: signAccessToken(memberId, user.email) }
}

const post = (url: string, token: string, body: object) =>
  new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })


const DOWN = { checked: false, reason: "error" }
const BIG = 500
const SMALL = 8

beforeEach(() => {
  mockCheckText.mockReset()
  mockHere.mockReset()
  emitted.length = 0
  recordTextSuccess()
  process.env.OPENAI_API_KEY = "sk-itest"
})

type Room = Awaited<ReturnType<typeof liveRoom>>
const send = (which: "group" | "event", r: Room, content: string) =>
  which === "group"
    ? groupRoute.POST(post(`http://localhost/api/mobile/chat/groups/${r.groupId}/messages`, r.token, { content, type: "text" }), {
        params: Promise.resolve({ chatGroupId: r.groupId }),
      })
    : eventRoute.POST(post(`http://localhost/api/mobile/events/${r.eventId}/chat`, r.token, { content, type: "text" }), {
        params: Promise.resolve({ eventId: r.eventId }),
      })
const rows = (r: Room) => db.chat_messages.count({ where: { chat_group_id: r.groupId } })

describe.each(["group", "event"] as const)("%s route", (which) => {
  it("a big room with no verdict gets 503 MODERATION_UNAVAILABLE, no row, no emit", async () => {
    const r = await liveRoom()
    mockHere.mockResolvedValue(BIG)
    mockCheckText.mockResolvedValue(DOWN)
    const res = await send(which, r, "hello big room")
    expect(res.status).toBe(503)
    expect(res.headers.get("Retry-After")).toBe("5")
    expect(await res.json()).toMatchObject({
      success: false,
      errorCode: "MODERATION_UNAVAILABLE",
      retryAfter: 5,
      error: "This room is busy and messages can’t be checked right now. Try again in a few seconds.",
    })
    expect(await rows(r)).toBe(0)
    expect(emitted).toEqual([])
  })

  it("a big room whose slow call answers after the 1 s mark still delivers on that verdict", async () => {
    const r = await liveRoom()
    mockHere.mockResolvedValue(BIG)
    mockCheckText.mockImplementation(() => new Promise((ok) => setTimeout(() => ok({ checked: true, result: null }), 1300)))
    const res = await send(which, r, "slow but fine")
    expect(res.status).toBe(201)
    expect(emitted).toEqual(["slow but fine"])
    expect(await rows(r)).toBe(1)
  })

  it("while a big room waits for the verdict, other members cannot read the line; after a clean one they can, and it is emitted once", async () => {
    const r = await liveRoom()
    mockHere.mockResolvedValue(BIG)
    mockCheckText.mockImplementation(() => new Promise((ok) => setTimeout(() => ok({ checked: true, result: null }), 1800)))
    // A second member, who reads the room while the first one's line is held.
    const otherId = await makeUser(testId("rs_o"))
    users.push(otherId)
    const other = await db.user.findUniqueOrThrow({ where: { id: otherId }, select: { email: true } })
    await db.chat_group_members.create({ data: { chat_group_id: r.groupId, user_id: otherId, anonymous_name: `Pseudo ${testId("o")}` } })
    const otherToken = signAccessToken(otherId, other.email)
    const readersSee = async () => {
      const history = await groupRoute.GET(
        new NextRequest(`http://localhost/api/mobile/chat/groups/${r.groupId}/messages`, { headers: { authorization: `Bearer ${otherToken}` } }),
        { params: Promise.resolve({ chatGroupId: r.groupId }) }
      )
      const served = ((await history.json()) as { data: { messages: { content: string | null }[] } }).data.messages
      const previews = await lastMessagesOf([r.groupId], [])
      return served.some((m) => m.content === "held line") || previews.some((p) => p.content === "held line")
    }

    const sending = send(which, r, "held line")
    await new Promise((resolve) => setTimeout(resolve, 1400)) // past the 1 s race, inside the wait
    expect(await readersSee()).toBe(false)
    expect(emitted).toEqual([])

    expect((await sending).status).toBe(201)
    expect(await readersSee()).toBe(true)
    expect(emitted).toEqual(["held line"])
  })

  it("a big room whose slow call answers with a hide hides it and emits nothing", async () => {
    const r = await liveRoom()
    mockHere.mockResolvedValue(BIG)
    const hide = { checked: true, result: { action: "hide", source: "openai_text", categories: { hate: 0.99 }, confidence: 0.99 } }
    mockCheckText.mockImplementation(() => new Promise((ok) => setTimeout(() => ok(hide), 1300)))
    const res = await send(which, r, "slow and awful")
    // A hide answers 200 with the sender told, as it always has.
    expect(res.status).toBe(200)
    expect(emitted).toEqual([])
    expect((await db.chat_messages.findFirstOrThrow({ where: { chat_group_id: r.groupId } })).moderation_status).toBe("hidden")
  })

  it("a small room still delivers the unchecked line", async () => {
    const r = await liveRoom()
    mockHere.mockResolvedValue(SMALL)
    mockCheckText.mockResolvedValue(DOWN)
    const res = await send(which, r, "dinner for eight")
    expect(res.status).toBe(201)
    expect(emitted).toEqual(["dinner for eight"])
    expect(await rows(r)).toBe(1)
  })

  it("with the breaker already open, a big room refuses before writing or asking", async () => {
    const r = await liveRoom()
    mockHere.mockResolvedValue(BIG)
    for (let i = 0; i < BREAKER_FAILURES_TO_OPEN; i++) recordTextFailure()
    const res = await send(which, r, "anyone?")
    expect(res.status).toBe(503)
    expect((await res.json()).errorCode).toBe("MODERATION_UNAVAILABLE")
    expect(mockCheckText).not.toHaveBeenCalled()
    expect(await rows(r)).toBe(0)
  })

  it("with the breaker open, a small room delivers as before", async () => {
    const r = await liveRoom()
    mockHere.mockResolvedValue(SMALL)
    mockCheckText.mockResolvedValue(DOWN)
    for (let i = 0; i < BREAKER_FAILURES_TO_OPEN; i++) recordTextFailure()
    expect((await send(which, r, "still here")).status).toBe(201)
  })

  it("a missing key is not an outage: a big room delivers", async () => {
    const r = await liveRoom()
    mockHere.mockResolvedValue(BIG)
    mockCheckText.mockResolvedValue({ checked: false, reason: "no_key" })
    expect((await send(which, r, "no key here")).status).toBe(201)
  })

  it("never counts the room when the first answer is a verdict", async () => {
    const r = await liveRoom()
    mockCheckText.mockResolvedValue({ checked: true, result: null })
    expect((await send(which, r, "all good")).status).toBe(201)
    expect(mockHere).not.toHaveBeenCalled()
  })
})
