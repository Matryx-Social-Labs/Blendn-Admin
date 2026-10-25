import { NextRequest } from "next/server"

/*
 * The sender sees their own withheld DM, as a removed message (RC8). The
 * recipient never sees it, and the readers that count what is delivered -- the
 * inbox preview and the unread count -- are unchanged. Real rows, real routes.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"
import { db, closeDb, makeUser, onboard, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const dmRoute = require("@/app/api/mobile/conversations/[conversationId]/messages/route") as
  typeof import("@/app/api/mobile/conversations/[conversationId]/messages/route")
const inboxRoute = require("@/app/api/mobile/conversations/route") as
  typeof import("@/app/api/mobile/conversations/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const users: string[] = []
const conversations: string[] = []

afterAll(async () => {
  if (conversations.length) {
    await db.private_messages.deleteMany({ where: { conversation_id: { in: conversations } } })
    await db.private_conversations.deleteMany({ where: { id: { in: conversations } } })
  }
  if (users.length) await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

async function person(label: string) {
  const id = await makeUser(testId(label))
  users.push(id)
  await onboard(id)
  const { email } = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
  return { id, auth: signAccessToken(id, email) }
}

const get = (url: string, auth: string) =>
  new NextRequest(url, { headers: { authorization: `Bearer ${auth}` } })

type Row = Record<string, unknown> & { id: string }

async function thread() {
  const a = await person("dsw_a")
  const b = await person("dsw_b")
  const c = await db.private_conversations.create({
    data: { user1_id: a.id, user2_id: b.id, user1_pseudonym: "Quiet Otter", user2_pseudonym: "Amber Fox" },
  })
  conversations.push(c.id)
  const say = (sender: string, data: { text: string; status?: string | null; media?: string; at?: Date }) =>
    db.private_messages.create({
      data: {
        conversation_id: c.id,
        sender_id: sender,
        message_text: data.text,
        moderation_status: data.status ?? null,
        ...(data.media && { media_url: data.media, media_type: "image" }),
        ...(data.at && { created_at: data.at }),
      },
      select: { id: true },
    })
  const open = async (who: { auth: string }, query = "") => {
    const res = await dmRoute.GET(get(`http://localhost/api/mobile/conversations/${c.id}/messages${query}`, who.auth), {
      params: Promise.resolve({ conversationId: c.id }),
    })
    return (await res.json()) as { data: { messages: Row[] } }
  }
  const inbox = async (who: { auth: string }) => {
    const res = await inboxRoute.GET(get("http://localhost/api/mobile/conversations", who.auth))
    const body = (await res.json()) as {
      data: { conversations: { id: string; unreadCount: number; lastMessage: { text: string } | null }[] }
    }
    return body.data.conversations.find((x) => x.id === c.id)!
  }
  return { a, b, say, open, inbox }
}

describe("a withheld DM", () => {
  it("is shown to its sender as removed, with the content withheld and the photo frame kept", async () => {
    const { a, say, open } = await thread()
    const ordinary = await say(a.id, { text: "hello" })
    const hidden = await say(a.id, { text: "slur", status: "hidden", media: "https://cdn.test/secret.jpg" })

    const row = (await open(a)).data.messages.find((m) => m.id === hidden.id)!
    expect(row).toMatchObject({
      moderation_hidden: true,
      text: null,
      mediaUrl: null,
      mediaType: "image",
      replyTo: null,
      isRead: false,
      deliveredAt: null,
    })
    expect(JSON.stringify(row)).not.toContain("slur")
    expect(JSON.stringify(row)).not.toContain("secret.jpg")

    const plain = (await open(a)).data.messages.find((m) => m.id === ordinary.id)!
    expect(plain.text).toBe("hello")
    expect(plain.moderation_hidden).toBeUndefined()
  })

  it("is never shown to the recipient", async () => {
    const { a, b, say, open } = await thread()
    await say(a.id, { text: "hello" })
    const hidden = await say(a.id, { text: "slur", status: "hidden" })

    const seen = (await open(b)).data.messages
    expect(seen.map((m) => m.text)).toEqual(["hello"])
    expect(seen.find((m) => m.id === hidden.id)).toBeUndefined()
  })

  it("still pages: the older hidden row of the sender arrives with the cursor, the recipient's view stays clean", async () => {
    const { a, b, say, open } = await thread()
    const now = Date.now()
    const old = await say(a.id, { text: "slur", status: "hidden", at: new Date(now - 60_000) })
    await say(a.id, { text: "hello", at: new Date(now - 1_000) })

    const before = new Date(now - 500).toISOString()
    expect((await open(a, `?before=${before}`)).data.messages.map((m) => m.id)).toContain(old.id)
    expect((await open(b, `?before=${before}`)).data.messages.map((m) => m.id)).not.toContain(old.id)
  })

  it("leaves the inbox preview and the unread count as they were", async () => {
    const { a, b, say, inbox } = await thread()
    await say(a.id, { text: "hello", at: new Date(Date.now() - 5_000) })
    await say(a.id, { text: "slur", status: "hidden" })

    const forRecipient = await inbox(b)
    expect(forRecipient.unreadCount).toBe(1)
    expect(forRecipient.lastMessage?.text).toBe("hello")
    const forSender = await inbox(a)
    expect(forSender.unreadCount).toBe(0)
    expect(forSender.lastMessage?.text).toBe("hello")
  })

  it("does not become unread when the recipient opens the thread", async () => {
    const { a, b, say, open } = await thread()
    const hidden = await say(a.id, { text: "slur", status: "hidden" })
    await open(b)
    const row = await db.private_messages.findUniqueOrThrow({ where: { id: hidden.id } })
    expect(row.delivered_at).toBeNull()
  })
})
