import { NextRequest } from "next/server"
import { randomUUID } from "crypto"

/*
 * A message carries the sender's own upload, or nothing (SCRUM-426).
 *
 * Found on staging: a DM's `mediaUrl` took any URL (`https://example.com/…gif`
 * was accepted and served to the recipient), and the room routes stored the
 * client's `metadata` verbatim, `z.record(…, z.any())`. The app reads
 * `metadata.sponsored_message_id` to draw a message as a sponsored card, so an
 * attendee could post one that looked like an ad or an announcement.
 *
 * And since R9 (SCRUM-626) a room takes no client metadata and no media at
 * all; since SCRUM-1165 a DM takes no photo either. Found by code reading:
 * both room routes took an attendee's image or video.
 */
// Signing a private URL is local HMAC: fake credentials are enough (SCRUM-427).
process.env.TIGRIS_ENDPOINT ??= "https://fly.storage.tigris.dev"
process.env.TIGRIS_ACCESS_KEY ??= "test-access"
process.env.TIGRIS_SECRET_KEY ??= "test-secret"
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/moderation", () => ({
  ...jest.requireActual("@/lib/moderation"),
  moderateMessage: jest.fn().mockResolvedValue(undefined),
}))
// The inline caption check, stubbed per test where a case needs it to have looked.
const mockCheckText = jest.fn()
jest.mock("@/lib/moderation/openai-moderation", () => {
  const actual = jest.requireActual("@/lib/moderation/openai-moderation")
  return { ...actual, checkTextContent: (text: string) => mockCheckText(text) ?? actual.checkTextContent(text) }
})
// Nothing a client sends into a room or a DM is copied: no send may reach the seal.
jest.mock("@/lib/tigris", () => ({ ...jest.requireActual("@/lib/tigris"), sealUpload: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"
import { conversationPair } from "@/lib/conversations"
import { db, closeDb, makeUser, onboard, testId } from "./helpers"
import { DM_PHOTOS_OFF, NO_ROOM_MEDIA } from "@/lib/validations/chat"
import { moderateMessage } from "@/lib/moderation"
import { sealUpload } from "@/lib/tigris"

beforeEach(() => jest.clearAllMocks())

// eslint-disable-next-line @typescript-eslint/no-require-imports
const groupRoute = require("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route") as
  typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const eventRoute = require("@/app/api/mobile/events/[eventId]/chat/route") as
  typeof import("@/app/api/mobile/events/[eventId]/chat/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const dmRoute = require("@/app/api/mobile/conversations/[conversationId]/messages/route") as
  typeof import("@/app/api/mobile/conversations/[conversationId]/messages/route")

const users: string[] = []
const events: string[] = []
const conversations: string[] = []
const HOUR = 60 * 60 * 1000

afterAll(async () => {
  if (conversations.length) {
    await db.private_messages.deleteMany({ where: { conversation_id: { in: conversations } } })
    await db.private_conversations.deleteMany({ where: { id: { in: conversations } } })
  }
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

/** The shape `getPresignedUploadUrl` gives a chat upload: the private bucket since SCRUM-427. */
const upload = (userId: string) =>
  `https://${process.env.TIGRIS_BUCKET || "blendn-media"}-private.fly.storage.tigris.dev/chat/${userId}/1790641297767-cfg6ta-photo.jpg`
const OUTSIDE = "https://example.com/pixel.gif"
/**
 * The route records an inline "clean" after it answers (`void db…update`), so a
 * read straight after the 201 can land first. Wait for the verdict, bounded.
 */
async function statusAfterSend(id: string, want: string) {
  for (let i = 0; ; i++) {
    const { moderation_status } = await db.chat_messages.findUniqueOrThrow({ where: { id }, select: { moderation_status: true } })
    if (moderation_status === want || i === 40) return moderation_status
    await new Promise((r) => setTimeout(r, 25))
  }
}

async function liveRoom() {
  const owner = await makeUser(testId("mm_own"), "organizer")
  users.push(owner)
  const now = Date.now()
  const event = await db.events.create({
    data: {
      slug: testId("mm"),
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
  const memberId = await makeUser(testId("mm_m"))
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

type Room = Awaited<ReturnType<typeof liveRoom>>

const ROUTES = [
  [
    "group route",
    (r: Room, body: object) =>
      groupRoute.POST(post(`http://localhost/api/mobile/chat/groups/${r.groupId}/messages`, r.token, body), {
        params: Promise.resolve({ chatGroupId: r.groupId }),
      }),
  ],
  [
    "event route",
    (r: Room, body: object) =>
      eventRoute.POST(post(`http://localhost/api/mobile/events/${r.eventId}/chat`, r.token, body), {
        params: Promise.resolve({ eventId: r.eventId }),
      }),
  ],
] as const

const written = (groupId: string, content: string) =>
  db.chat_messages.count({ where: { chat_group_id: groupId, content } })

describe("a reply's quote of a message that was taken down (SCRUM-444)", () => {
  it("shows neither its words nor its media, on the group route's list", async () => {
    const r = await liveRoom()
    const sendToGroup = ROUTES[0][1]
    // A photo from before R9: a room takes none now, and the ones it took are still read.
    const quoted = await db.chat_messages.create({
      data: {
        chat_group_id: r.groupId,
        user_id: r.memberId,
        content: "look",
        type: "image",
        metadata: { mediaUrl: `https://${process.env.TIGRIS_BUCKET || "blendn-media"}-private.fly.storage.tigris.dev/chat/sealed/${randomUUID()}` },
      },
    })
    // Replied to in the second before the image check hid it.
    expect((await sendToGroup(r, { content: "nice", type: "text", parentId: quoted.id })).status).toBe(201)
    await db.chat_messages.update({ where: { id: quoted.id }, data: { moderation_status: "hidden", deleted_at: new Date() } })

    const res = await groupRoute.GET(
      new NextRequest(`http://localhost/api/mobile/chat/groups/${r.groupId}/messages`, {
        headers: { authorization: `Bearer ${r.token}` },
      }),
      { params: Promise.resolve({ chatGroupId: r.groupId }) }
    )
    const { data } = (await res.json()) as { data: { messages: Array<{ content: string | null; parent_message: unknown }> } }
    const reply = data.messages.find((m) => m.content === "nice")
    expect(reply?.parent_message).toMatchObject({ id: quoted.id, content: null, metadata: null, moderation_hidden: true })
    expect(JSON.stringify(reply?.parent_message)).not.toContain("chat/sealed/")
  })
})

describe("a room message is words only, from a client (R9, SCRUM-626)", () => {
  for (const [name, send] of ROUTES) {
    it(`refuses metadata that would draw the message as sponsored, on the ${name}`, async () => {
      const r = await liveRoom()
      for (const metadata of [
        { sponsored_message_id: "fake" },
        // Nor alongside a photo.
        { mediaUrl: upload(r.memberId), sponsored_message_id: "fake" },
      ]) {
        const res = await send(r, { content: "buy now", type: "text", metadata })
        expect(res.status).toBe(400)
        expect(JSON.stringify(await res.json())).toMatch(/metadata/)
      }
      expect(await written(r.groupId, "buy now")).toBe(0)
      // The same message without it is an ordinary send.
      expect((await send(r, { content: "buy now", type: "text" })).status).toBe(201)
    })

    it(`refuses a photo or a video, the sender's own upload included, and seals nothing, on the ${name}`, async () => {
      const r = await liveRoom()
      for (const body of [
        { content: "look", type: "image", metadata: { mediaUrl: upload(r.memberId) } },
        // The type is the client's word: a "text" message cannot carry one either.
        { content: "look", type: "text", metadata: { mediaUrl: upload(r.memberId) } },
        { content: "look", type: "image", metadata: { mediaUrl: OUTSIDE } },
        // Nor be called one without it: the room list and the push would say "📷 Photo".
        { content: "look", type: "video" },
        // No metadata at all, empty included.
        { content: "look", metadata: {} },
      ]) {
        const res = await send(r, body)
        expect(res.status).toBe(400)
        const { errors } = (await res.json()) as { errors?: Array<{ message: string }> }
        expect(errors?.map((e) => e.message)).toContain(NO_ROOM_MEDIA)
      }
      expect(await written(r.groupId, "look")).toBe(0)
      expect(sealUpload).not.toHaveBeenCalled()
    })

    it(`writes a plain text message clean inline and leaves the pipeline out of it, on the ${name}`, async () => {
      const r = await liveRoom()
      mockCheckText.mockResolvedValueOnce({ checked: true, result: null })
      expect((await send(r, { content: "just words", type: "text" })).status).toBe(201)
      const row = await db.chat_messages.findFirstOrThrow({ where: { chat_group_id: r.groupId, content: "just words" } })
      expect(await statusAfterSend(row.id, "clean")).toBe("clean")
      expect(moderateMessage).not.toHaveBeenCalled()
    })
  }
})

describe("a DM takes no photo (SCRUM-1165)", () => {
  /** Two friends with a conversation: the pair the old rule let send photos. */
  async function friends() {
    const ids = [await makeUser(testId("mm_a")), await makeUser(testId("mm_b"))]
    users.push(...ids)
    await onboard(...ids)
    const conversation = await db.private_conversations.create({
      data: { user1_id: ids[0], user2_id: ids[1], user1_revealed: true, user2_revealed: true },
    })
    conversations.push(conversation.id)
    const [user1_id, user2_id] = conversationPair(ids[0], ids[1])
    await db.friendships.create({ data: { user1_id, user2_id } })
    const a = await db.user.findUniqueOrThrow({ where: { id: ids[0] }, select: { email: true } })
    return { a: ids[0], b: ids[1], conversationId: conversation.id, token: signAccessToken(ids[0], a.email) }
  }
  type Pair = Awaited<ReturnType<typeof friends>>
  const send = (p: Pair, body: object) =>
    dmRoute.POST(post(`http://localhost/api/mobile/conversations/${p.conversationId}/messages`, p.token, body), {
      params: Promise.resolve({ conversationId: p.conversationId }),
    })
  const dms = (p: Pair) => db.private_messages.count({ where: { conversation_id: p.conversationId } })

  it("refuses any photo with a sentence the app shows as it is, copies nothing and writes nothing", async () => {
    const p = await friends()
    for (const body of [
      // The sender's own upload, as the app sends it.
      { mediaUrl: upload(p.a), mediaType: "image" },
      { mediaUrl: upload(p.a) },
      // With words: the whole send is refused, not the photo dropped.
      { text: "look", mediaUrl: upload(p.a), mediaType: "image", clientId: randomUUID() },
      // Anything in mediaUrl at all.
      { mediaUrl: OUTSIDE },
      { mediaUrl: upload(p.b), mediaType: "video" },
      { mediaUrl: "not a url" },
    ]) {
      const res = await send(p, body)
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({ success: false, error: DM_PHOTOS_OFF, errorCode: "FORBIDDEN" })
    }
    expect(sealUpload).not.toHaveBeenCalled()
    expect(await dms(p)).toBe(0)
  })

  it("still takes words between the same two people", async () => {
    const p = await friends()
    // A text send that also says mediaType, as an installed app may, is still words.
    for (const body of [{ text: "see you at the bar" }, { text: "on my way", mediaType: "image" }]) {
      expect((await send(p, body)).status).toBe(200)
    }
    const rows = await db.private_messages.findMany({ where: { conversation_id: p.conversationId } })
    expect(rows.map((r) => [r.message_text, r.media_url, r.media_type]).sort()).toEqual([
      ["on my way", null, null],
      ["see you at the bar", null, null],
    ])
  })

  it("still serves a photo sent before, signed", async () => {
    const p = await friends()
    const stored = `https://${process.env.TIGRIS_BUCKET || "blendn-media"}-private.fly.storage.tigris.dev/chat/sealed/${randomUUID()}`
    await db.private_messages.create({
      data: { conversation_id: p.conversationId, sender_id: p.b, media_url: stored, media_type: "image" },
    })
    const res = await dmRoute.GET(
      new NextRequest(`http://localhost/api/mobile/conversations/${p.conversationId}/messages`, {
        headers: { authorization: `Bearer ${p.token}` },
      }),
      { params: Promise.resolve({ conversationId: p.conversationId }) }
    )
    expect(res.status).toBe(200)
    const { data } = (await res.json()) as { data: { messages: Array<{ mediaUrl: string; mediaType: string }> } }
    expect(data.messages).toHaveLength(1)
    expect(data.messages[0].mediaType).toBe("image")
    const served = new URL(data.messages[0].mediaUrl)
    expect(served.searchParams.has("X-Amz-Signature")).toBe(true)
    expect(served.pathname.endsWith(new URL(stored).pathname)).toBe(true)
  })
})
