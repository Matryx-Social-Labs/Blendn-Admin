import { NextRequest } from "next/server"

/*
 * A message carries the sender's own upload, or nothing (SCRUM-426).
 *
 * Found on staging: a DM's `mediaUrl` took any URL (`https://example.com/…gif`
 * was accepted and served to the recipient), and the room routes stored the
 * client's `metadata` verbatim, `z.record(…, z.any())`. The app reads
 * `metadata.sponsored_message_id` to draw a message as a sponsored card, so an
 * attendee could post one that looked like an ad or an announcement.
 *
 * Now: a room message's client metadata is `{ mediaUrl }` and nothing else,
 * and every media URL, room or DM, is the sender's own `chat/<id>/` upload on
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
jest.mock("@/lib/tigris", () => ({
  ...jest.requireActual("@/lib/tigris"),
  sealUpload: jest.fn(async (key: string, _folder: string, userId: string) =>
    key.endsWith("-missing.jpg")
      ? { refused: "missing" }
      : {
          key: `chat/${userId}/sealed-copy`,
          url: `https://${process.env.TIGRIS_BUCKET || "blendn-media"}-private.fly.storage.tigris.dev/chat/${userId}/sealed-copy`,
          bytes: 120_000,
          contentType: "image/jpeg",
        }
  ),
}))

import { signAccessToken } from "@/lib/mobile-auth"
import { db, closeDb, makeUser, onboard, testId } from "./helpers"
import { NOT_OWN_MEDIA } from "@/lib/validations/chat"
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
const sealed = (userId: string) =>
  `https://${process.env.TIGRIS_BUCKET || "blendn-media"}-private.fly.storage.tigris.dev/chat/${userId}/sealed-copy`
/** An upload URL whose object never arrived. */
const unfinished = (userId: string) => upload(userId).replace("-photo.jpg", "-missing.jpg")

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

describe("a room message's metadata comes from the client only as its own media", () => {
  for (const [name, send] of ROUTES) {
    it(`refuses metadata that would draw the message as sponsored, on the ${name}`, async () => {
      const r = await liveRoom()
      for (const metadata of [
        { sponsored_message_id: "fake" },
        // A permitted key does not carry a forbidden one in with it.
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

    it(`refuses a media URL that is not the sender's own upload, on the ${name}`, async () => {
      const r = await liveRoom()
      const other = await makeUser(testId("mm_other"))
      users.push(other)
      for (const [type, mediaUrl] of [
        ["image", OUTSIDE],
        ["image", upload(other)],
        // Not gated on the type: a "text" message cannot carry one either.
        ["text", OUTSIDE],
      ]) {
        const res = await send(r, { content: "look", type, metadata: { mediaUrl } })
        expect(res.status).toBe(400)
        expect(((await res.json()) as { error?: string }).error).toBe(NOT_OWN_MEDIA)
      }
      expect(await written(r.groupId, "look")).toBe(0)
    })

    it(`accepts the sender's own upload and stores its sealed copy, on the ${name}`, async () => {
      const r = await liveRoom()
      const res = await send(r, { content: "look", type: "image", metadata: { mediaUrl: upload(r.memberId) } })
      expect(res.status).toBe(201)
      const row = await db.chat_messages.findFirstOrThrow({ where: { chat_group_id: r.groupId, content: "look" } })
      expect(row.metadata).toEqual({ mediaUrl: sealed(r.memberId) })
      // The response hands the media back signed, and nowhere bare (SCRUM-427).
      const body = JSON.stringify(await res.json())
      const served = [...body.matchAll(/https:[^"]*\/chat\/[^"]*sealed-copy[^"]*/g)].map((m) => m[0])
      expect(served.length).toBeGreaterThan(0)
      for (const url of served) expect(url).toContain("X-Amz-Signature")
      // The image the moderator scans is the copy the room sees, not the source its URL can still rewrite.
      expect(moderateMessage).toHaveBeenCalledWith(row.id, "look", "image", r.memberId, r.groupId, sealed(r.memberId))
    })

    it(`screens the image on a "text" message that carries one, on the ${name} (SCRUM-444)`, async () => {
      const r = await liveRoom()
      const res = await send(r, { content: "hi", type: "text", metadata: { mediaUrl: upload(r.memberId) } })
      expect(res.status).toBe(201)
      const row = await db.chat_messages.findFirstOrThrow({ where: { chat_group_id: r.groupId, content: "hi" } })
      // The type is the client's word; the image is what the room sees.
      expect(moderateMessage).toHaveBeenCalledWith(row.id, "hi", "text", r.memberId, r.groupId, sealed(r.memberId))
    })

    it(`copies nothing for a send it refuses, or for a retry, on the ${name}`, async () => {
      const r = await liveRoom()
      // Not a member: refused before anything is copied.
      const stranger = await makeUser(testId("mm_str"))
      users.push(stranger)
      const { email } = await db.user.findUniqueOrThrow({ where: { id: stranger }, select: { email: true } })
      const refused = await send({ ...r, memberId: stranger, token: signAccessToken(stranger, email) }, {
        content: "look", type: "image", metadata: { mediaUrl: upload(stranger) },
      })
      expect(refused.status).toBeGreaterThanOrEqual(400)
      expect(sealUpload).not.toHaveBeenCalled()
      // A retry of a send that landed is answered with the first write, and copies nothing more.
      const body = { content: "again", type: "image", metadata: { mediaUrl: upload(r.memberId) }, clientId: "8c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f".replace(/^.{8}/, Math.random().toString(16).slice(2, 10).padEnd(8, "0")) }
      expect((await send(r, body)).status).toBeLessThan(300)
      expect((await send(r, body)).status).toBeLessThan(300)
      expect(sealUpload).toHaveBeenCalledTimes(1)
    })

    it(`refuses an upload that cannot be sealed, and writes nothing, on the ${name}`, async () => {
      const r = await liveRoom()
      const res = await send(r, { content: "look", type: "image", metadata: { mediaUrl: unfinished(r.memberId) } })
      expect(res.status).toBe(400)
      expect(await written(r.groupId, "look")).toBe(0)
    })
  }
})

describe("a DM's media is the sender's own upload", () => {
  async function pair() {
    const ids = [await makeUser(testId("mm_a")), await makeUser(testId("mm_b"))]
    users.push(...ids)
    await onboard(...ids)
    const conversation = await db.private_conversations.create({
      data: { user1_id: ids[0], user2_id: ids[1], user1_pseudonym: "Quiet Otter", user2_pseudonym: "Amber Fox" },
    })
    conversations.push(conversation.id)
    const a = await db.user.findUniqueOrThrow({ where: { id: ids[0] }, select: { email: true } })
    return { a: ids[0], b: ids[1], conversationId: conversation.id, token: signAccessToken(ids[0], a.email) }
  }
  const send = (p: Awaited<ReturnType<typeof pair>>, body: object) =>
    dmRoute.POST(post(`http://localhost/api/mobile/conversations/${p.conversationId}/messages`, p.token, body), {
      params: Promise.resolve({ conversationId: p.conversationId }),
    })

  it("refuses an outside URL and the other person's upload, and writes nothing", async () => {
    const p = await pair()
    for (const mediaUrl of [OUTSIDE, upload(p.b)]) {
      const res = await send(p, { mediaUrl, mediaType: "image" })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error?: string }).error).toBe(NOT_OWN_MEDIA)
    }
    expect(await db.private_messages.count({ where: { conversation_id: p.conversationId } })).toBe(0)
  })

  it("accepts the sender's own upload and stores its sealed copy", async () => {
    const p = await pair()
    const res = await send(p, { mediaUrl: upload(p.a), mediaType: "image" })
    expect(res.status).toBe(200)
    const row = await db.private_messages.findFirstOrThrow({ where: { conversation_id: p.conversationId } })
    expect(row.media_url).toBe(sealed(p.a))
    // Stored as the bare private reference; handed back signed and short-lived (SCRUM-427).
    const served = new URL(((await res.json()) as { data: { mediaUrl: string } }).data.mediaUrl)
    expect(served.searchParams.has("X-Amz-Signature")).toBe(true)
    expect(served.searchParams.get("X-Amz-Expires")).toBe("900")
    expect(served.pathname).toContain(`/chat/${p.a}/sealed-copy`)
  })

  it("copies nothing for a send it refuses: a block either way", async () => {
    const p = await pair()
    await db.blocked_users.create({ data: { blocker_id: p.b, blocked_id: p.a } })
    const res = await send(p, { mediaUrl: upload(p.a), mediaType: "image" })
    expect(res.status).toBe(403)
    expect(sealUpload).not.toHaveBeenCalled()
    await db.blocked_users.deleteMany({ where: { blocker_id: p.b, blocked_id: p.a } })
  })

  it("refuses an upload that cannot be sealed, and writes nothing", async () => {
    const p = await pair()
    const res = await send(p, { mediaUrl: unfinished(p.a), mediaType: "image" })
    expect(res.status).toBe(400)
    expect(await db.private_messages.count({ where: { conversation_id: p.conversationId } })).toBe(0)
  })
})
