import { NextRequest } from "next/server"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"
import { db, closeDb, makeUser, onboard, testId } from "./helpers"
import { recordStatements, shape } from "./statements"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const inboxRoute = require("@/app/api/mobile/conversations/route") as typeof import("@/app/api/mobile/conversations/route")

/**
 * The inbox shows each conversation's newest VISIBLE message. It asked Prisma
 * for `messages: { orderBy: created_at desc, take: 1 }`, and Prisma 7 here never
 * sends the `take` to SQL for a nested relation: the statement is
 * `WHERE conversation_id IN (…) ORDER BY created_at DESC` with no LIMIT, so every
 * DM of every conversation the person has came back, to keep one per thread.
 */

const users: string[] = []
const conversations: string[] = []

afterAll(async () => {
  await db.private_messages.deleteMany({ where: { conversation_id: { in: conversations } } })
  await db.private_conversations.deleteMany({ where: { id: { in: conversations } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

async function person(label: string) {
  const id = await makeUser(testId(label))
  users.push(id)
  await onboard(id)
  return { id, token: signAccessToken(id, `${id}@itest.invalid`) }
}

async function thread(me: string, other: string, messages: { text: string; from: string; ago: number; status?: string | null; read?: boolean }[]) {
  const [user1_id, user2_id] = me < other ? [me, other] : [other, me]
  const conv = await db.private_conversations.create({ data: { user1_id, user2_id, last_message_at: new Date() } })
  conversations.push(conv.id)
  for (const m of messages) {
    await db.private_messages.create({
      data: {
        conversation_id: conv.id,
        sender_id: m.from,
        message_text: m.text,
        moderation_status: m.status ?? null,
        is_read: m.read ?? false,
        created_at: new Date(Date.now() - m.ago * 60_000),
      },
    })
  }
  return conv.id
}

it("shows the newest visible message per conversation, with its unread count, from a LIMITed read", async () => {
  const me = await person("inbox-me")
  const [a, b, c] = await Promise.all([person("inbox-a"), person("inbox-b"), person("inbox-c")])

  // A: 40 messages; the newest two are hidden/flagged-but-visible. Hidden never shows; flagged does.
  const many = Array.from({ length: 40 }, (_, i) => ({ text: `old ${i}`, from: i % 2 ? me.id : a.id, ago: 1000 - i, read: true }))
  const withA = await thread(me.id, a.id, [
    ...many,
    { text: "visible newest", from: a.id, ago: 5, status: "flagged" },
    { text: "hidden newest", from: a.id, ago: 1, status: "hidden" },
  ])
  // B: one message of mine. C: no messages at all.
  const withB = await thread(me.id, b.id, [{ text: "mine last", from: me.id, ago: 3, status: "clean", read: true }])
  const withC = await thread(me.id, c.id, [])

  const { result: res, statements } = await recordStatements(() =>
    inboxRoute.GET(new NextRequest("http://localhost/api/mobile/conversations", { headers: { authorization: `Bearer ${me.token}` } }))
  )
  expect(res.status).toBe(200)
  const list = (await res.json()).data.conversations as { id: string; lastMessage: { text: string; senderId: string } | null; unreadCount: number }[]
  const byId = new Map(list.map((c) => [c.id, c]))
  console.log("inbox:", shape(statements))

  expect(byId.get(withA)?.lastMessage?.text).toBe("visible newest")
  expect(byId.get(withA)?.lastMessage?.senderId).toBe(a.id)
  // unread = not mine, not read, visible: only "visible newest" ("hidden newest" is never delivered)
  expect(byId.get(withA)?.unreadCount).toBe(1)
  expect(byId.get(withB)?.lastMessage?.text).toBe("mine last")
  expect(byId.get(withB)?.unreadCount).toBe(0)
  expect(byId.get(withC)?.lastMessage).toBeNull()

  // The last message is one LIMITed read, not "every message of these conversations".
  const lastReads = statements.filter((s) => /private_messages/.test(s.sql) && /message_text/.test(s.sql))
  expect(lastReads).toHaveLength(1)
  expect(lastReads[0].sql).toMatch(/LIMIT 1/i)
  // And the unread counts name these conversations, not "every unread DM there is" (the old `_count` join).
  expect(statements.filter((s) => /LEFT JOIN \(SELECT "public"\."private_messages"/.test(s.sql))).toHaveLength(0)
})
