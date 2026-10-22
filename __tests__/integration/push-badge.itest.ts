/**
 * The app icon's number rides on every push (SCRUM-740), counted as
 * `GET /notifications` counts `badgeCount`, against Postgres, through the real
 * senders with only the Expo transport captured. A bulk send counts everybody
 * in a fixed number of statements, never one per recipient.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"

const mockSent: { to: string; badge?: number }[] = []
jest.mock("expo-server-sdk", () => ({
  Expo: class {
    static isExpoPushToken() {
      return true
    }
    chunkPushNotifications(m: unknown[]) {
      return [m]
    }
    async sendPushNotificationsAsync(chunk: { to: string; badge?: number }[]) {
      mockSent.push(...chunk)
      return chunk.map(() => ({ status: "ok", id: "ticket" }))
    }
  },
}))

import { Client } from "pg"
import { signAccessToken } from "@/lib/mobile-auth"
import { sendBulkPushNotifications, sendPushNotification } from "@/lib/push-notifications"
import { cleanup, closeDb, db, makeUser, testId } from "./helpers"
import { req } from "./go-live-world"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const readRoute = require("@/app/api/mobile/notifications/read/route") as typeof import("@/app/api/mobile/notifications/read/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const feed = require("@/app/api/mobile/notifications/route") as typeof import("@/app/api/mobile/notifications/route")

const users: string[] = []
const conversations: string[] = []
afterAll(async () => {
  await db.private_messages.deleteMany({ where: { conversation_id: { in: conversations } } })
  await db.private_conversations.deleteMany({ where: { id: { in: conversations } } })
  await db.notifications.deleteMany({ where: { user_id: { in: users } } })
  await db.push_tokens.deleteMany({ where: { user_id: { in: users } } })
  await cleanup(users, [])
  await closeDb()
}, 120_000)
beforeEach(() => {
  mockSent.length = 0
})

async function statementsDuring<T>(run: () => Promise<T>) {
  const statements: string[] = []
  const original = Client.prototype.query
  Client.prototype.query = function (this: Client, ...args: unknown[]) {
    const first = args[0] as string | { text?: string }
    statements.push(typeof first === "string" ? first : first.text ?? "")
    return (original as (...a: unknown[]) => unknown).apply(this, args)
  } as typeof Client.prototype.query
  try {
    return { result: await run(), statements }
  } finally {
    Client.prototype.query = original
  }
}

async function person(label: string, opts: { device?: boolean } = {}) {
  const id = await makeUser(testId(label))
  users.push(id)
  if (opts.device !== false) await db.push_tokens.create({ data: { user_id: id, token: `ExponentPushToken[${id}]`, platform: "ios" } })
  return id
}

/** `unread` bell rows, `read` read ones, and a DM thread from a stranger with one unread message. */
async function seed(id: string, o: { unread?: number; read?: number; thread?: "visible" | "hidden" | "mine" | "closed" } = {}) {
  const rows = (n: number, read_at: Date | null) =>
    Array.from({ length: n }, () => ({ user_id: id, kind: "friend_request" as const, title: "t", body: "b", data: { type: "friend_request" }, read_at }))
  await db.notifications.createMany({ data: [...rows(o.unread ?? 0, null), ...rows(o.read ?? 0, new Date())] })
  if (!o.thread) return
  const other = await person(`pb-other-${id.slice(-6)}`, { device: false })
  const [user1_id, user2_id] = [id, other].sort()
  const conversation = await db.private_conversations.create({ data: { user1_id, user2_id, ...(o.thread === "closed" && { closed_at: new Date() }) } })
  conversations.push(conversation.id)
  await db.private_messages.create({
    data: {
      conversation_id: conversation.id,
      sender_id: o.thread === "mine" ? id : other,
      message_text: "hi",
      ...(o.thread === "hidden" && { moderation_status: "hidden" }),
    },
  })
}

const badgeFromFeed = async (id: string) =>
  (await (await feed.GET(req("/api/mobile/notifications?limit=1", signAccessToken(id, `${id}@itest.invalid`)))).json()).data.badgeCount as number
const badgeOf = (id: string) => mockSent.find((m) => m.to === `ExponentPushToken[${id}]`)?.badge

describe("a single push", () => {
  it("carries the count the feed serves, the new bell row included", async () => {
    const id = await person("pb-one")
    await seed(id, { unread: 2, read: 3, thread: "visible" })
    await expect(sendPushNotification({ userId: id, title: "t", body: "b", data: { type: "friend_request" } })).resolves.toBe(true)
    // 2 unread + the one this push wrote + 1 conversation: the read rows do not count.
    expect(badgeOf(id)).toBe(4)
    expect(await badgeFromFeed(id)).toBe(4)
  })

  it.each(["hidden", "mine", "closed"] as const)("does not count a %s direct message", async (thread) => {
    const id = await person(`pb-dm-${thread}`)
    await seed(id, { thread })
    await sendPushNotification({ userId: id, title: "t", body: "b", data: { type: "friend_request" } })
    expect(badgeOf(id)).toBe(1)
    expect(await badgeFromFeed(id)).toBe(1)
  })

  it("counts a message that never reaches the bell once: the thread, not a bell row", async () => {
    const id = await person("pb-dmpush")
    await seed(id, { thread: "visible" })
    await sendPushNotification({ userId: id, title: "t", body: "b", data: { type: "private_message" } })
    expect(badgeOf(id)).toBe(1)
  })
})

describe("a bulk push", () => {
  it("gives each recipient their own count, as the feed counts it, and nothing to a person with no device", async () => {
    const a = await person("pb-a")
    const b = await person("pb-b")
    const c = await person("pb-c")
    const none = await person("pb-none", { device: false })
    await seed(a, { unread: 5 })
    await seed(b, { unread: 1, thread: "visible" })
    await seed(c, { read: 4 })
    await sendBulkPushNotifications({ userIds: [a, b, c, none], title: "t", body: "b", data: { type: "announcement", eventId: "e1" } })
    expect([badgeOf(a), badgeOf(b), badgeOf(c)]).toEqual([6, 3, 1])
    expect(mockSent).toHaveLength(3)
    for (const id of [a, b, c]) expect(badgeOf(id)).toBe(await badgeFromFeed(id))
  })

  it("counts in the same statements for 3 recipients and for 40, once each", async () => {
    const make = async (n: number) => {
      const ids = await Promise.all(Array.from({ length: n }, (_, i) => person(`pb-n${n}-${i}`)))
      for (const id of ids) await seed(id, { unread: 1 })
      return ids
    }
    const small = await make(3)
    const large = await make(40)
    const run = (userIds: string[]) =>
      statementsDuring(() => sendBulkPushNotifications({ userIds, title: "t", body: "b", data: { type: "announcement", eventId: "e1" } }))
    await run(small) // warm: the pool and the schema
    mockSent.length = 0
    const ofSmall = await run(small)
    mockSent.length = 0
    const ofLarge = await run(large)
    expect(ofLarge.statements).toHaveLength(ofSmall.statements.length)
    const counts = (s: string[]) => ({
      bell: s.filter((t) => /FROM "public"."notifications"/i.test(t) && /GROUP BY/i.test(t)).length,
      threads: s.filter((t) => /FROM private_conversations/i.test(t)).length,
    })
    expect(counts(ofLarge.statements)).toEqual({ bell: 1, threads: 1 })
    // Each of the 40 had 1 unread and was sent this announcement, whose row is the second.
    expect(mockSent.map((m) => m.badge)).toEqual(large.map(() => 2))
  })
})

describe("the cap", () => {
  const CAP = 1000 // written out: the app says "999+" past it

  it("the feed, the mark-read answer and every push stop counting unread bell rows at 1000", async () => {
    const id = await person("pb-cap")
    await seed(id, { unread: CAP + 5, thread: "visible" })
    const token = signAccessToken(id, `${id}@itest.invalid`)
    const body = (await (await feed.GET(req("/api/mobile/notifications?limit=1", token))).json()).data
    expect(body.unreadCount).toBe(CAP)
    expect(body.badgeCount).toBe(CAP + 1) // the thread is beside the capped bell count

    await sendPushNotification({ userId: id, title: "t", body: "b", data: { type: "friend_request" } })
    expect(badgeOf(id)).toBe(CAP + 1)

    // Marking one of them read leaves 1,004 unread, and the answer says 1,000.
    const one = await db.notifications.findFirstOrThrow({ where: { user_id: id }, select: { id: true } })
    const marked = (await (await readRoute.POST(req("/api/mobile/notifications/read", token, "POST", { ids: [one.id] }))).json()).data
    expect(marked.unreadCount).toBe(CAP)
  })

  it("a bulk send caps each recipient's bell count too, and one person's count stops reading at the cap", async () => {
    const [a, b] = [await person("pb-capbulk-a"), await person("pb-capbulk-b")]
    await seed(a, { unread: CAP + 5 })
    await seed(b, { unread: 3 })
    await sendBulkPushNotifications({ userIds: [a, b], title: "t", body: "b", data: { type: "announcement", eventId: "e1" } })
    expect([badgeOf(a), badgeOf(b)]).toEqual([CAP, 4])

    // One person: the count itself is `LIMIT`ed (the scan ends at the 1000th row); several: a groupBy, which cannot be.
    mockSent.length = 0
    const one = await statementsDuring(() => sendPushNotification({ userId: a, title: "t", body: "b", data: { type: "friend_request" } }))
    expect(badgeOf(a)).toBe(CAP)
    const bellCount = one.statements.filter((t) => /count/i.test(t) && /FROM "public"."notifications"/i.test(t) && /read_at/.test(t))
    expect(bellCount).toHaveLength(1)
    expect(bellCount[0]).toMatch(/LIMIT \$\d+/i)
    expect(bellCount[0]).not.toMatch(/GROUP BY/i)
  })

  it("counts exactly below it", async () => {
    const id = await person("pb-below")
    await seed(id, { unread: CAP - 1 })
    const body = (await (await feed.GET(req("/api/mobile/notifications?limit=1", signAccessToken(id, `${id}@itest.invalid`)))).json()).data
    expect(body.unreadCount).toBe(CAP - 1)
  })
})
