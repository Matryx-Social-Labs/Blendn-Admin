import { NextRequest } from "next/server"

/*
 * The DM routes' independent reads run side by side (perf/chat-path), and
 * nothing that decides an answer has moved: the same refusal wins, in the same
 * order, for the same request.
 *
 * Every Prisma operation is held for LAG ms here, so two reads that overlap are
 * unmistakable (one interval inside the other's) and two that run in series are
 * LAG ms apart; a millisecond-resolution race cannot flip it.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

const emitted: { at: number }[] = []
jest.mock("@/lib/socket-server", () => ({
  ...jest.requireActual("@/lib/socket-server"),
  emitPrivateMessage: () => void emitted.push({ at: performance.now() }),
}))

import { PrismaClient } from "@prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { signAccessToken } from "@/lib/mobile-auth"
import { db, closeDb, makeUser, onboard, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const route = require("@/app/api/mobile/conversations/[conversationId]/messages/route") as typeof import("@/app/api/mobile/conversations/[conversationId]/messages/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const LAG = 60
interface Span {
  op: string
  start: number
  end: number
}
const spans: Span[] = []
const overlap = (a: string, b: string) => {
  const x = spans.find((s) => s.op === a)
  const y = spans.find((s) => s.op === b)
  if (!x || !y) throw new Error(`missing ${!x ? a : b} in ${spans.map((s) => s.op).join(", ")}`)
  return x.start < y.end && y.start < x.end
}

let base: PrismaClient
let previousGlobal: PrismaClient | undefined
const users: string[] = []
const conversations: string[] = []

beforeAll(() => {
  previousGlobal = globalThis.prisma
  base = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) })
  globalThis.prisma = base.$extends({
    query: {
      async $allOperations({ model, operation, args, query }: { model?: string; operation: string; args: unknown; query: (a: unknown) => Promise<unknown> }) {
        const span = { op: `${model}.${operation}`, start: performance.now(), end: 0 }
        spans.push(span)
        await new Promise((r) => setTimeout(r, LAG))
        try {
          return await query(args)
        } finally {
          span.end = performance.now()
        }
      },
    },
  }) as unknown as PrismaClient
})
afterAll(async () => {
  globalThis.prisma = previousGlobal
  await base.$disconnect()
  if (conversations.length) {
    await db.private_messages.deleteMany({ where: { conversation_id: { in: conversations } } })
    await db.private_conversations.deleteMany({ where: { id: { in: conversations } } })
  }
  if (users.length) {
    await db.blocked_users.deleteMany({ where: { OR: [{ blocker_id: { in: users } }, { blocked_id: { in: users } }] } })
    await db.user.deleteMany({ where: { id: { in: users } } })
  }
  await closeDb()
})
beforeEach(() => {
  spans.length = 0
  emitted.length = 0
})

async function person(label: string, finished = true) {
  const id = await makeUser(testId(label))
  users.push(id)
  if (finished) await onboard(id)
  const { email } = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
  return { id, token: signAccessToken(id, email) }
}
async function pair() {
  const a = await person("dp_a")
  const b = await person("dp_b")
  const c = await db.private_conversations.create({
    data: { user1_id: a.id, user2_id: b.id, user1_pseudonym: "Quiet Otter", user2_pseudonym: "Amber Fox" },
  })
  conversations.push(c.id)
  return { a, b, conversationId: c.id }
}

const send = (conversationId: string, token: string, body: object) =>
  route.POST(
    new NextRequest(`http://localhost/api/mobile/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ conversationId }) }
  )
const read = (conversationId: string, token: string) =>
  route.GET(new NextRequest(`http://localhost/api/mobile/conversations/${conversationId}/messages`, { headers: { authorization: `Bearer ${token}` } }), {
    params: Promise.resolve({ conversationId }),
  })

describe("sending", () => {
  it("reads the sender's standing, a retry of this send and the conversation side by side", async () => {
    const { a, conversationId } = await pair()
    const res = await send(conversationId, a.token, { text: "corner table", clientId: crypto.randomUUID() })
    expect(res.status).toBe(200)
    expect(overlap("profiles.findUnique", "private_conversations.findUnique")).toBe(true)
    expect(overlap("profiles.findUnique", "private_messages.findUnique")).toBe(true)
  })

  it("checks the quoted message and the block together", async () => {
    const { a, conversationId } = await pair()
    const first = await (await send(conversationId, a.token, { text: "first one" })).json()
    spans.length = 0
    const res = await send(conversationId, a.token, { text: "and a second", replyToId: first.data.id })
    expect(res.status).toBe(200)
    expect(overlap("private_messages.findFirst", "blocked_users.findFirst")).toBe(true)
  })

  it("tells the room before the conversation's clock has been written", async () => {
    const { a, conversationId } = await pair()
    const res = await send(conversationId, a.token, { text: "straight away" })
    expect(res.status).toBe(200)
    const touched = spans.find((s) => s.op === "private_conversations.update")!
    expect(emitted).toHaveLength(1)
    expect(emitted[0].at).toBeLessThan(touched.end)
    // …and the clock was written before the answer.
    const row = await db.private_conversations.findUniqueOrThrow({ where: { id: conversationId }, select: { last_message_at: true } })
    expect(row.last_message_at).not.toBeNull()
  })

  it("answers the first refusal in the old order: unfinished before invalid, a missing quote before a block", async () => {
    const unfinished = await person("dp_u", false)
    const other = await person("dp_o")
    const c = await db.private_conversations.create({ data: { user1_id: unfinished.id, user2_id: other.id } })
    conversations.push(c.id)
    expect((await send(c.id, unfinished.token, { nonsense: true })).status).toBe(403)

    const { a, b, conversationId } = await pair()
    await db.blocked_users.create({ data: { blocker_id: b.id, blocked_id: a.id } })
    expect((await send(conversationId, a.token, { text: "hi", replyToId: crypto.randomUUID() })).status).toBe(400)
    expect((await send(conversationId, a.token, { text: "hi" })).status).toBe(403)
  })

  it("does not tell the room about, or bump the conversation for, a message that was hidden", async () => {
    const { a, conversationId } = await pair()
    const res = await send(conversationId, a.token, { text: "you absolute retard" })
    expect((await res.json()).data.moderation_hidden).toBe(true)
    expect(emitted).toHaveLength(0)
    const row = await db.private_conversations.findUniqueOrThrow({ where: { id: conversationId }, select: { last_message_at: true } })
    expect(row.last_message_at).toBeNull()
  })
})

describe("reading", () => {
  it("reads the conversation and its messages side by side", async () => {
    const { a, conversationId } = await pair()
    const res = await read(conversationId, a.token)
    expect(res.status).toBe(200)
    expect(overlap("private_conversations.findUnique", "private_messages.findMany")).toBe(true)
  })

  it("gives a stranger nothing and marks nothing read", async () => {
    const { a, b, conversationId } = await pair()
    const sent = await db.private_messages.create({ data: { conversation_id: conversationId, sender_id: a.id, message_text: "private" } })
    const stranger = await person("dp_s")
    const res = await read(conversationId, stranger.token)
    expect(res.status).toBe(403)
    expect(JSON.stringify(await res.json())).not.toContain("private")
    expect((await db.private_messages.findUniqueOrThrow({ where: { id: sent.id } })).is_read).toBe(false)
    // The recipient opening it marks it read, after reading it as unread.
    const opened = await (await read(conversationId, b.token)).json()
    expect(opened.data.messages[0].text).toBe("private")
    expect((await db.private_messages.findUniqueOrThrow({ where: { id: sent.id } })).is_read).toBe(true)
  })
})
