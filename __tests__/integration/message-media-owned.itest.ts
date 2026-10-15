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
 * And since R9 (SCRUM-626), photos go in a DM only: a room takes no client
 * metadata and no media at all, and a DM takes a photo once both people are
 * named to each other, or are friends. Found by code reading: both room routes
 * took an attendee's image or video, and a DM took one from a stranger whose
 * pseudonym was all the recipient knew.
 *
 * Every media URL that is taken is the sender's own `chat/<id>/` upload on
 * our bucket.
 */
// Signing a private URL is local HMAC: fake credentials are enough (SCRUM-427).
process.env.TIGRIS_ENDPOINT ??= "https://fly.storage.tigris.dev"
process.env.TIGRIS_ACCESS_KEY ??= "test-access"
process.env.TIGRIS_SECRET_KEY ??= "test-secret"
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
/*
 * And what is stored is the sealed copy, never the URL the client uploaded to,
 * which can still be written for 15 minutes (SCRUM-425). The copy itself is
 * `sealUpload`'s, tested in upload-seal.test.ts; here, that the routes store it.
 */
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
// Each seal mints its own chat/sealed/<uuid>, as sealUpload does since SCRUM-448: no user id in it.
// `mockSealDelayMs` holds a seal open so two racing sends both get past the retry lookup.
let mockSealDelayMs = 0
jest.mock("@/lib/tigris", () => ({
  ...jest.requireActual("@/lib/tigris"),
  deleteFile: jest.fn().mockResolvedValue(undefined),
  sealUpload: jest.fn(async (key: string) => {
    if (key.endsWith("-missing.jpg")) return { refused: "missing" }
    if (mockSealDelayMs) await new Promise((resolve) => setTimeout(resolve, mockSealDelayMs))
    const sealedKey = `chat/sealed/${jest.requireActual("crypto").randomUUID()}`
    return {
      key: sealedKey,
      url: `https://${process.env.TIGRIS_BUCKET || "blendn-media"}-private.fly.storage.tigris.dev/${sealedKey}`,
      bytes: 120_000,
      contentType: "image/jpeg",
    }
  }),
}))

import { signAccessToken } from "@/lib/mobile-auth"
import { conversationPair } from "@/lib/conversations"
import { db, closeDb, makeUser, onboard, testId } from "./helpers"
import { DM_PHOTOS_NOT_YET, NO_ROOM_MEDIA, NOT_OWN_MEDIA } from "@/lib/validations/chat"
import { moderateMessage } from "@/lib/moderation"
import { deleteFile, sealUpload } from "@/lib/tigris"

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
/** The URL of the copy the last seal minted. */
const sealed = () => (sealUpload as jest.Mock).mock.results.at(-1)!.value.then((r: { url: string }) => r.url) as Promise<string>
/** An upload URL whose object never arrived. */
const unfinished = (userId: string) => upload(userId).replace("-photo.jpg", "-missing.jpg")

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

describe("a DM's media is the sender's own photo, once both are named to each other (R9, SCRUM-626)", () => {
  /** A match's conversation: pseudonyms, and by default both revealed. */
  async function pair(opts: { revealed?: [boolean, boolean]; pseudonymous?: boolean } = {}) {
    const ids = [await makeUser(testId("mm_a")), await makeUser(testId("mm_b"))]
    users.push(...ids)
    await onboard(...ids)
    const [user1_revealed, user2_revealed] = opts.revealed ?? [true, true]
    const conversation = await db.private_conversations.create({
      data: {
        user1_id: ids[0],
        user2_id: ids[1],
        ...(opts.pseudonymous !== false && { user1_pseudonym: "Quiet Otter", user2_pseudonym: "Amber Fox" }),
        user1_revealed,
        user2_revealed,
      },
    })
    conversations.push(conversation.id)
    const a = await db.user.findUniqueOrThrow({ where: { id: ids[0] }, select: { email: true } })
    return { a: ids[0], b: ids[1], conversationId: conversation.id, token: signAccessToken(ids[0], a.email) }
  }
  const send = (p: Awaited<ReturnType<typeof pair>>, body: object) =>
    dmRoute.POST(post(`http://localhost/api/mobile/conversations/${p.conversationId}/messages`, p.token, body), {
      params: Promise.resolve({ conversationId: p.conversationId }),
    })
  const dms = (p: { conversationId: string }) => db.private_messages.count({ where: { conversation_id: p.conversationId } })

  it("refuses an outside URL and the other person's upload, and writes nothing", async () => {
    const p = await pair()
    for (const mediaUrl of [OUTSIDE, upload(p.b)]) {
      const res = await send(p, { mediaUrl, mediaType: "image" })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error?: string }).error).toBe(NOT_OWN_MEDIA)
    }
    expect(await dms(p)).toBe(0)
  })

  it("accepts the sender's own upload once both have revealed, and stores its sealed copy as a photo", async () => {
    const p = await pair()
    // No mediaType: a photo is all a DM takes, so it is stored as one.
    const res = await send(p, { mediaUrl: upload(p.a) })
    expect(res.status).toBe(200)
    const row = await db.private_messages.findFirstOrThrow({ where: { conversation_id: p.conversationId } })
    expect(row.media_url).toBe(await sealed())
    expect(row.media_type).toBe("image")
    // Stored as the bare private reference; handed back signed and short-lived (SCRUM-427).
    const { data } = (await res.json()) as { data: { mediaUrl: string; mediaType: string } }
    expect(data.mediaType).toBe("image")
    const served = new URL(data.mediaUrl)
    expect(served.searchParams.has("X-Amz-Signature")).toBe(true)
    expect(served.searchParams.get("X-Amz-Expires")).toBe("900")
    // Signed path-style against the private bucket: the key is what must match.
    expect(served.pathname.endsWith(new URL(row.media_url!).pathname)).toBe(true)
    expect(served.pathname).not.toContain(p.a)
  })

  it.each([
    ["neither has revealed", [false, false]],
    ["only the sender has", [true, false]],
    ["only the recipient has", [false, true]],
  ] as const)("refuses a photo when %s, seals nothing, and still takes words", async (_label, revealed) => {
    const p = await pair({ revealed: [...revealed] })
    const res = await send(p, { mediaUrl: upload(p.a), mediaType: "image" })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error?: string }).error).toBe(DM_PHOTOS_NOT_YET)
    expect(sealUpload).not.toHaveBeenCalled()
    expect(await dms(p)).toBe(0)
    expect((await send(p, { text: "hi" })).status).toBe(200)
  })

  it("takes a photo between friends who have not revealed", async () => {
    const p = await pair({ revealed: [false, false] })
    const [user1_id, user2_id] = conversationPair(p.a, p.b)
    await db.friendships.create({ data: { user1_id, user2_id } })
    expect((await send(p, { mediaUrl: upload(p.a), mediaType: "image" })).status).toBe(200)
    expect(await dms(p)).toBe(1)
  })

  it("takes a photo where nobody was ever a pseudonym: an accepted message request", async () => {
    const p = await pair({ pseudonymous: false, revealed: [false, false] })
    expect((await send(p, { mediaUrl: upload(p.a), mediaType: "image" })).status).toBe(200)
  })

  it("refuses a video: a DM takes photos only", async () => {
    const p = await pair()
    const res = await send(p, { mediaUrl: upload(p.a), mediaType: "video" })
    expect(res.status).toBe(400)
    expect(sealUpload).not.toHaveBeenCalled()
    expect(await dms(p)).toBe(0)
  })

  it.each([
    ["the recipient blocked the sender", (p: { a: string; b: string }) => ({ blocker_id: p.b, blocked_id: p.a })],
    ["the sender blocked the recipient", (p: { a: string; b: string }) => ({ blocker_id: p.a, blocked_id: p.b })],
  ])("copies nothing for a send it refuses when %s, and says so before anything about photos", async (_label, block) => {
    // Unrevealed, so the photo rule would refuse too: the block is asked first, and says nothing about photos.
    const p = await pair({ revealed: [false, false] })
    await db.blocked_users.create({ data: block(p) })
    const res = await send(p, { mediaUrl: upload(p.a), mediaType: "image" })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error?: string }).error).toBe("You cannot send messages to this user")
    expect(sealUpload).not.toHaveBeenCalled()
    await db.blocked_users.deleteMany({ where: block(p) })
  })

  it("answers a retry of a photo that landed with the first write, and seals nothing more", async () => {
    const p = await pair()
    const body = { mediaUrl: upload(p.a), mediaType: "image", clientId: randomUUID() }
    expect((await send(p, body)).status).toBe(200)
    expect((await send(p, body)).status).toBe(200)
    expect(await dms(p)).toBe(1)
    expect(sealUpload).toHaveBeenCalledTimes(1)
  })

  it("refuses an upload that cannot be sealed, and writes nothing", async () => {
    const p = await pair()
    const res = await send(p, { mediaUrl: unfinished(p.a), mediaType: "image" })
    expect(res.status).toBe(400)
    expect(await dms(p)).toBe(0)
  })

  it("removes the copy a racing retry sealed and did not keep (SCRUM-448)", async () => {
    const p = await pair()
    const body = { mediaUrl: upload(p.a), mediaType: "image", clientId: randomUUID() }
    mockSealDelayMs = 300
    const [x, y] = await Promise.all([send(p, body), send(p, body)]).finally(() => (mockSealDelayMs = 0))
    expect([x.status, y.status].every((s) => s < 300)).toBe(true)
    const rows = await db.private_messages.findMany({ where: { conversation_id: p.conversationId } })
    expect(rows).toHaveLength(1)
    const minted = await Promise.all((sealUpload as jest.Mock).mock.results.map((m) => m.value.then((v: { key?: string }) => v.key)))
    // Both got past the retry lookup and sealed; the loser's copy is the one removed.
    expect(minted).toHaveLength(2)
    const lost = minted.filter((k) => k && !rows[0].media_url!.endsWith(k))
    expect(lost).toHaveLength(1)
    expect((deleteFile as jest.Mock).mock.calls.map(([k]) => k)).toEqual(lost)
  })
})
