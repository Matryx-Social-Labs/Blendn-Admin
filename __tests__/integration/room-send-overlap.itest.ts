import { NextRequest } from "next/server"

/*
 * A room send, against a real database (perf/chat-path).
 *
 * OpenAI moderation was ~95% of a send's server time (0.35-1.04 s, a floor of
 * ~300 ms Singapore-to-US). It stays in front of the emit exactly as before —
 * complete or time out at 1 s, then deliver — but it now overlaps the database
 * work, runs once per message rather than twice on a timeout, and a reply's
 * push no longer holds the sender's 201.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

const order: string[] = []
const mockCheckText = jest.fn()
jest.mock("@/lib/moderation/openai-moderation", () => ({
  ...jest.requireActual("@/lib/moderation/openai-moderation"),
  checkTextContent: (...a: unknown[]) => mockCheckText(...a),
}))
jest.mock("@/lib/socket-server", () => ({
  ...jest.requireActual("@/lib/socket-server"),
  emitChatMessage: (...a: unknown[]) => void order.push(`emit:${(a[1] as { content: string }).content}`),
}))

const PUSH_MS = 400
const pushDone: number[] = []
jest.mock("expo-server-sdk", () => ({
  Expo: class {
    static isExpoPushToken() {
      return true
    }
    chunkPushNotifications(m: unknown[]) {
      return [m]
    }
    async sendPushNotificationsAsync(chunk: unknown[]) {
      order.push("push:sent")
      await new Promise((r) => setTimeout(r, PUSH_MS))
      pushDone.push(Date.now())
      return chunk.map(() => ({ status: "ok", id: "ticket" }))
    }
  },
}))

import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { signAccessToken } from "@/lib/mobile-auth"
import { db, closeDb, makeUser, onboard, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const groupRoute = require("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route")
const eventRoute = require("@/app/api/mobile/events/[eventId]/chat/route") as typeof import("@/app/api/mobile/events/[eventId]/chat/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const HOUR = 60 * 60 * 1000
const users: string[] = []
const events: string[] = []

// Records the order Prisma operations START in, beside the moderation call and the emit.
let base: PrismaClient
let previousGlobal: PrismaClient | undefined
beforeAll(() => {
  previousGlobal = globalThis.prisma
  base = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) })
  globalThis.prisma = base.$extends({
    query: {
      async $allOperations({ model, operation, args, query }: { model?: string; operation: string; args: unknown; query: (a: unknown) => Promise<unknown> }) {
        if (model === "chat_messages" && operation === "create") order.push("db:create")
        if (model === "chat_groups" && operation === "update") order.push("db:last_message_at")
        return query(args)
      },
    },
  }) as unknown as PrismaClient
})

afterAll(async () => {
  globalThis.prisma = previousGlobal
  await base.$disconnect()
  if (events.length) {
    const groups = await db.chat_groups.findMany({ where: { event_id: { in: events } }, select: { id: true } })
    const ids = groups.map((g) => g.id)
    await db.moderation_flags.deleteMany({ where: { chat_group_id: { in: ids } } })
    await db.chat_messages.deleteMany({ where: { chat_group_id: { in: ids } } })
    await db.chat_group_members.deleteMany({ where: { chat_group_id: { in: ids } } })
    await db.chat_groups.deleteMany({ where: { id: { in: ids } } })
    await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
    await db.events.deleteMany({ where: { id: { in: events } } })
  }
  if (users.length) {
    await db.notifications.deleteMany({ where: { user_id: { in: users } } })
    await db.push_tokens.deleteMany({ where: { user_id: { in: users } } })
    await db.user.deleteMany({ where: { id: { in: users } } })
  }
  await closeDb()
})

beforeEach(() => {
  order.length = 0
  pushDone.length = 0
  mockCheckText.mockReset()
  mockCheckText.mockImplementation(async () => {
    order.push("moderation:start")
    return { checked: true, result: null }
  })
})

async function room() {
  const owner = await makeUser(testId("ro_own"), "organizer")
  users.push(owner)
  const event = await db.events.create({
    data: {
      slug: testId("ro"),
      title: "Overlap",
      description: "integration fixture",
      start_time: new Date(Date.now() - HOUR),
      end_time: new Date(Date.now() + 3 * HOUR),
      timezone: "UTC",
      status: "published",
      organizer_id: owner,
    },
  })
  events.push(event.id)
  await db.event_occurrences.create({
    data: { event_id: event.id, occurs_on: new Date(event.start_time.toISOString().slice(0, 10)), start_time: event.start_time, end_time: event.end_time },
  })
  const group = await db.chat_groups.create({ data: { event_id: event.id, name: "Overlap", status: "active", last_message_at: new Date("2026-01-01T00:00:00Z") } })
  const member = async (label: string) => {
    const id = await makeUser(testId(label))
    users.push(id)
    await onboard(id)
    await db.push_tokens.create({ data: { user_id: id, token: `ExponentPushToken[${testId(label)}]`, platform: "ios" } })
    await db.chat_group_members.create({ data: { chat_group_id: group.id, user_id: id, anonymous_name: `Pseudo ${testId(label)}` } })
    const { email } = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
    return { id, auth: signAccessToken(id, email) }
  }
  return { eventId: event.id, groupId: group.id, member }
}

const post = (url: string, auth: string, body: object) =>
  new NextRequest(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${auth}` }, body: JSON.stringify(body) })

type Room = Awaited<ReturnType<typeof room>>
const viaGroup = (r: Room, who: { auth: string }, content: string, parentId?: string) =>
  groupRoute.POST(post(`http://localhost/api/mobile/chat/groups/${r.groupId}/messages`, who.auth, { content, type: "text", ...(parentId && { parentId }) }), {
    params: Promise.resolve({ chatGroupId: r.groupId }),
  })
const viaEvent = (r: Room, who: { auth: string }, content: string, parentId?: string) =>
  eventRoute.POST(post(`http://localhost/api/mobile/events/${r.eventId}/chat`, who.auth, { content, type: "text", ...(parentId && { parentId }) }), {
    params: Promise.resolve({ eventId: r.eventId }),
  })

const until = async (check: () => boolean | Promise<boolean>, ms = 4000) => {
  for (let waited = 0; waited < ms; waited += 25) {
    if (await check()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return false
}
const lastMessageAt = async (groupId: string) => (await db.chat_groups.findUniqueOrThrow({ where: { id: groupId }, select: { last_message_at: true } })).last_message_at

describe.each([
  ["group route", viaGroup, async (res: Response) => ((await res.json()) as { data: { id: string } }).data.id],
  ["event route", viaEvent, async (res: Response) => ((await res.json()) as { data: { message: { id: string } } }).data.message.id],
] as const)("the %s", (_name, send, idOf) => {
  it("starts the moderation call before it writes the message, and delivers only after both", async () => {
    const r = await room()
    const ana = await r.member("ro_a")
    const res = await send(r, ana, "see you at nine")
    expect(res.status).toBe(201)
    const at = (e: string) => order.indexOf(e)
    expect(at("moderation:start")).toBeGreaterThanOrEqual(0)
    // Overlapped with the write, not after it…
    expect(at("moderation:start")).toBeLessThan(at("db:create"))
    // …and still ahead of the room's copy.
    expect(at("emit:see you at nine")).toBeGreaterThan(at("moderation:start"))
    expect(at("emit:see you at nine")).toBeGreaterThan(at("db:last_message_at"))
  })

  it("asks OpenAI once for a message whose check outlasts the 1 s wait, and records its verdict", async () => {
    const r = await room()
    const ana = await r.member("ro_b")
    mockCheckText.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1300))
      return { checked: true, result: null }
    })
    const res = await send(r, ana, "a slow one")
    expect(res.status).toBe(201)
    const id = await idOf(res)
    // The pipeline reuses the first call's answer: still one call, and its verdict lands.
    expect(await until(async () => (await db.chat_messages.findUniqueOrThrow({ where: { id } })).moderation_status === "clean")).toBe(true)
    expect(mockCheckText).toHaveBeenCalledTimes(1)
  })

  it("hides what the model hides before anyone is told, and does not bump the room for it", async () => {
    const r = await room()
    const ana = await r.member("ro_c")
    const before = await lastMessageAt(r.groupId)
    mockCheckText.mockImplementation(async () => ({
      checked: true,
      result: { action: "hide", source: "openai_text", categories: { hate: 0.99 }, confidence: 0.99 },
    }))
    const res = await send(r, ana, "something the model hides")
    expect(res.status).toBe(200)
    expect(order.some((e) => e.startsWith("emit:"))).toBe(false)
    expect(await lastMessageAt(r.groupId)).toEqual(before)
  })

  it("answers a reply before its push has gone out, and still sends the push", async () => {
    const r = await room()
    const ana = await r.member("ro_d")
    const ben = await r.member("ro_e")
    const asked = await idOf(await send(r, ana, "who is by the bar?"))
    order.length = 0
    const res = await send(r, ben, "me", asked)
    const answeredAt = Date.now()
    expect(res.status).toBe(201)
    // The push is in flight when the 201 is back (it takes PUSH_MS to finish)…
    expect(pushDone).toHaveLength(0)
    // …and arrives.
    expect(await until(() => pushDone.length === 1)).toBe(true)
    expect(pushDone[0]).toBeGreaterThan(answeredAt)
    expect(order).toContain("push:sent")
  })
})
