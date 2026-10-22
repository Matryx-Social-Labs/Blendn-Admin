import { NextRequest } from "next/server"
import { Client } from "pg"

/*
 * The inbox preview (M3): each conversation's newest visible message from ONE
 * query, the same rule as the Prisma `VISIBLE_DM` the thread uses, and a query
 * count that does not grow with the page.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
import { signAccessToken } from "@/lib/mobile-auth"
import { VISIBLE_DM } from "@/lib/dm-moderation"
import { latestVisibleMessages } from "@/lib/inbox-preview"
import { cleanup, closeDb, db, makeUser, testId } from "./helpers"
/* eslint-disable @typescript-eslint/no-require-imports */
const inbox = require("@/app/api/mobile/conversations/route") as typeof import("@/app/api/mobile/conversations/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const users: string[] = []
let me = { id: "", token: "" }
const MIN = 60_000
const base = Date.now() - 100 * MIN

afterAll(async () => {
  const convs = await db.private_conversations.findMany({ where: { OR: [{ user1_id: me.id }, { user2_id: me.id }] }, select: { id: true } })
  await db.private_messages.deleteMany({ where: { conversation_id: { in: convs.map((c) => c.id) } } })
  await db.private_conversations.deleteMany({ where: { id: { in: convs.map((c) => c.id) } } })
  await cleanup(users, [])
  await closeDb()
})

beforeAll(async () => {
  const id = await makeUser(testId("ip-me"))
  users.push(id)
  const { email } = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
  me = { id, token: signAccessToken(id, email) }
})

async function conversation(label: string, messages: { text: string; at: number; from?: "me" | "them"; status?: string | null }[]) {
  const other = await makeUser(testId(label))
  users.push(other)
  const conv = await db.private_conversations.create({
    data: { user1_id: me.id < other ? me.id : other, user2_id: me.id < other ? other : me.id, created_at: new Date(base) },
  })
  for (const m of messages) {
    await db.private_messages.create({
      data: {
        conversation_id: conv.id,
        sender_id: m.from === "me" ? me.id : other,
        message_text: m.text,
        moderation_status: m.status ?? null,
        created_at: new Date(base + m.at * MIN),
      },
    })
  }
  if (messages.length) await db.private_conversations.update({ where: { id: conv.id }, data: { last_message_at: new Date(base + Math.max(...messages.map((m) => m.at)) * MIN) } })
  return conv.id
}

/** What the nested `messages: { where: VISIBLE_DM, orderBy created_at desc, take: 1 }` returned. */
const reference = async (id: string) =>
  (await db.private_messages.findFirst({ where: { conversation_id: id, ...VISIBLE_DM }, orderBy: [{ created_at: "desc" }, { id: "desc" }], select: { id: true, message_text: true, sender_id: true, created_at: true, is_read: true } })) ?? undefined

it("matches the old behaviour on every status, including a hidden newest message and a conversation with nothing visible", async () => {
  const plain = await conversation("ip-plain", [{ text: "one", at: 1 }, { text: "two", at: 2 }])
  const hiddenNewest = await conversation("ip-hidden", [{ text: "kept", at: 1 }, { text: "SECRET hidden words", at: 5, status: "hidden" }])
  const onlyHidden = await conversation("ip-onlyhidden", [{ text: "SECRET only", at: 1, status: "hidden" }])
  const flagged = await conversation("ip-flagged", [{ text: "older", at: 1 }, { text: "flagged is visible", at: 2, status: "flagged" }])
  const clean = await conversation("ip-clean", [{ text: "clean one", at: 3, status: "clean" }, { text: "mine", at: 4, from: "me" }])
  const empty = await conversation("ip-empty", [])
  const ids = [plain, hiddenNewest, onlyHidden, flagged, clean, empty]

  const got = await latestVisibleMessages(ids)
  for (const id of ids) expect(got.get(id)).toEqual(await reference(id))
  expect(got.get(hiddenNewest)!.message_text).toBe("kept")
  expect(got.has(onlyHidden)).toBe(false)
  expect(got.has(empty)).toBe(false)
  expect(got.get(flagged)!.message_text).toBe("flagged is visible")
  expect(got.get(clean)!.sender_id).toBe(me.id)
})

it("the route shows the preview, never a hidden message's words, and an empty conversation has none", async () => {
  const res = await inbox.GET(new NextRequest("http://localhost/api/mobile/conversations", { headers: { authorization: `Bearer ${me.token}` } }))
  expect(res.status).toBe(200)
  const text = JSON.stringify(await res.json())
  expect(text).not.toContain("SECRET")
  const { data } = JSON.parse(text) as { data: { conversations: { lastMessage: { text: string } | null }[] } }
  const previews = data.conversations.map((c) => c.lastMessage?.text ?? null)
  expect(previews).toEqual(expect.arrayContaining(["two", "kept", "flagged is visible", "mine", null]))
})

it("ids are bound, not interpolated: a hostile id is an error, not an injection", async () => {
  await expect(latestVisibleMessages(["x'); DROP TABLE private_messages; --"])).rejects.toThrow()
  expect(await db.private_messages.count()).toBeGreaterThan(0)
})

describe("the preview costs the same however many conversations are listed", () => {
  /** Statements run against `private_messages` for message text while `run` runs. */
  async function previewReads(run: () => Promise<unknown>) {
    const seen: string[] = []
    const original = Client.prototype.query
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(Client.prototype as any).query = function (this: Client, ...args: any[]) {
      const first = args[0]
      const text = typeof first === "string" ? first : (first?.text as string | undefined)
      if (text && /message_text/.test(text)) seen.push(text)
      return (original as (...a: unknown[]) => unknown).apply(this, args)
    }
    try {
      await run()
    } finally {
      Client.prototype.query = original
    }
    return seen
  }

  it("one read of message text for 3 conversations and for 40", async () => {
    const few = await previewReads(() => inbox.GET(new NextRequest("http://localhost/api/mobile/conversations?limit=3", { headers: { authorization: `Bearer ${me.token}` } })))
    for (let i = 0; i < 40; i++) await conversation(`ip-bulk${i}`, [{ text: `m${i}`, at: 10 + i }])
    const many = await previewReads(() => inbox.GET(new NextRequest("http://localhost/api/mobile/conversations?limit=50", { headers: { authorization: `Bearer ${me.token}` } })))
    expect(few).toHaveLength(1)
    expect(many).toHaveLength(1)
  })
})
