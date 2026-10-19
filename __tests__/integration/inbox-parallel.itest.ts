import { NextRequest } from "next/server"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"
import { db, closeDb, makeUser, onboard, testId } from "./helpers"
import { laggedDb } from "./lagged-db"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const inboxRoute = require("@/app/api/mobile/conversations/route") as typeof import("@/app/api/mobile/conversations/route")

/**
 * The inbox reads the conversations, THEN the newest message of each and the
 * unread counts, which need only the conversation ids and so run side by side.
 * Every operation is held 60 ms: overlap is unmistakable.
 */
const lag = laggedDb(60)
const users: string[] = []
const conversations: string[] = []

afterAll(async () => {
  await lag.restore()
  await db.private_messages.deleteMany({ where: { conversation_id: { in: conversations } } })
  await db.private_conversations.deleteMany({ where: { id: { in: conversations } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

it("reads the last messages and the unread counts side by side, after the conversations", async () => {
  const ids = await Promise.all(["me", "other"].map(async (l) => {
    const id = await makeUser(testId(`inpar-${l}`))
    users.push(id)
    await onboard(id)
    return id
  }))
  const [me, other] = ids
  const [user1_id, user2_id] = me < other ? [me, other] : [other, me]
  const conv = await db.private_conversations.create({ data: { user1_id, user2_id, last_message_at: new Date() } })
  conversations.push(conv.id)
  await db.private_messages.create({ data: { conversation_id: conv.id, sender_id: other, message_text: "hello" } })
  const { email } = await db.user.findUniqueOrThrow({ where: { id: me }, select: { email: true } })

  lag.install()
  const res = await inboxRoute.GET(
    new NextRequest("http://localhost/api/mobile/conversations", { headers: { authorization: `Bearer ${signAccessToken(me, email)}` } })
  )
  expect(res.status).toBe(200)
  const list = (await res.json()).data.conversations as { lastMessage: { text: string } | null; unreadCount: number }[]
  expect(list[0]).toMatchObject({ lastMessage: { text: "hello" }, unreadCount: 1 })

  // $queryRaw is the LATERAL last-message read; groupBy is the unread counts.
  expect(lag.overlap(".$queryRaw", "private_messages.groupBy")).toBe(true)
  // …and both came after the conversations, which they need the ids from.
  const conversationsRead = lag.spans.find((s) => s.op === "private_conversations.findMany")!
  const lastRead = lag.spans.find((s) => s.op === ".$queryRaw")!
  expect(lastRead.start).toBeGreaterThanOrEqual(conversationsRead.end)
})
