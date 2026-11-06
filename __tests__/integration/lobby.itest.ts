import { NextRequest } from "next/server"

/*
 * The Lobby (SCRUM-1026), against a real Postgres: types and spots, a photo
 * from upload to approval (its location stripped, its URL kept from everyone
 * but its author until it passes), the filters, the preview, the room's card,
 * the alerts and who they reach, and the lifecycle's edges.
 *
 * Storage is the one thing faked: the S3 client answers like Tigris does, so
 * the seal really reads the upload, really strips it, and the bytes it writes
 * are the ones checked here.
 */
process.env.TIGRIS_ENDPOINT = "https://fly.storage.tigris.dev"
process.env.TIGRIS_ACCESS_KEY = "test-access"
process.env.TIGRIS_SECRET_KEY = "test-secret"
process.env.TIGRIS_BUCKET = "blendn-media-test"

const mockSend = jest.fn()
jest.mock("@aws-sdk/client-s3", () => {
  const actual = jest.requireActual("@aws-sdk/client-s3")
  return { ...actual, S3Client: jest.fn().mockImplementation(() => ({ send: mockSend, config: {} })) }
})
jest.mock("@aws-sdk/s3-request-presigner", () => ({
  // A signed URL is the stored reference plus a signature: enough to tell who was handed one.
  getSignedUrl: jest.fn(async (_c: unknown, command: { input: { Key: string } }) => `https://signed.example/${command.input.Key}?X-Amz-Signature=t`),
}))
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3"
import { signAccessToken } from "@/lib/mobile-auth"
import { moderateLobbyPhoto, recheckPendingPhotos } from "@/lib/lobby-photo"
import { matchRecipients } from "@/lib/lobby"
import { pushGates } from "@/lib/push-notifications"
import { feeScheduleFromMarket, type MarketFeeRow } from "@/lib/ticket-fees"
import { bytesOf, has, JPEG_WITH_GPS, METADATA } from "../support/gps-photos"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"
/* eslint-disable @typescript-eslint/no-require-imports */
const boardRoute = require("@/app/api/mobile/events/[eventId]/board/route") as typeof import("@/app/api/mobile/events/[eventId]/board/route")
const postRoute = require("@/app/api/mobile/events/[eventId]/board/[postId]/route") as typeof import("@/app/api/mobile/events/[eventId]/board/[postId]/route")
const previewRoute = require("@/app/api/mobile/events/[eventId]/board/preview/route") as typeof import("@/app/api/mobile/events/[eventId]/board/preview/route")
const summaryRoute = require("@/app/api/mobile/events/[eventId]/board/summary/route") as typeof import("@/app/api/mobile/events/[eventId]/board/summary/route")
const alertsRoute = require("@/app/api/mobile/events/[eventId]/board/alerts/route") as typeof import("@/app/api/mobile/events/[eventId]/board/alerts/route")
const messagesRoute = require("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route")
const eventChat = require("@/app/api/mobile/events/[eventId]/chat/route") as typeof import("@/app/api/mobile/events/[eventId]/chat/route")
const myRequests = require("@/app/api/mobile/board/requests/route") as typeof import("@/app/api/mobile/board/requests/route")
const requestsRoute = require("@/app/api/mobile/events/[eventId]/board/[postId]/requests/route") as typeof import("@/app/api/mobile/events/[eventId]/board/[postId]/requests/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const users: string[] = []
const events: string[] = []
const categories: string[] = []
type Person = { id: string; token: string }

afterAll(async () => {
  await db.board_alert_preferences.deleteMany({ where: { event_id: { in: events } } })
  await db.board_requests.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await db.event_favorites.deleteMany({ where: { event_id: { in: events } } })
  await db.board_posts.deleteMany({ where: { event_id: { in: events } } })
  await db.user_interests.deleteMany({ where: { user_id: { in: users } } })
  await db.categories.deleteMany({ where: { id: { in: categories } } })
  await closeDb()
})

beforeAll(async () => {
  for (const n of [1, 2]) {
    const slug = testId(`lob-cat-${n}`)
    categories.push((await db.categories.create({ data: { name: slug, slug }, select: { id: true } })).id)
  }
})

/** An event whose doors are a day away. */
async function upcoming(): Promise<string> {
  const host = await makeUser(testId("lob-host"), "organizer")
  users.push(host)
  const id = await makeEvent(host)
  events.push(id)
  const start = new Date(Date.now() + 24 * 3_600_000)
  await db.events.update({ where: { id }, data: { start_time: start, end_time: new Date(start.getTime() + 3 * 3_600_000) } })
  return id
}

/** Going, with a profile complete enough to post. */
async function poster(label: string, eventId: string): Promise<Person> {
  const id = await makeUser(testId(label))
  users.push(id)
  const born = new Date()
  born.setFullYear(born.getFullYear() - 30)
  await db.profiles.create({ data: { id, name: `Test ${label}`, date_of_birth: born, intent_default: ["friendship"], onboarded: true } })
  await db.user_interests.createMany({ data: categories.map((category_id) => ({ user_id: id, category_id })) })
  await db.event_rsvps.create({ data: { event_id: eventId, user_id: id, status: "going" } })
  const { email } = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
  return { id, token: signAccessToken(id, email) }
}

/** Onboarded, and neither saved nor going. */
async function outsider(label: string): Promise<Person> {
  const id = await makeUser(testId(label))
  users.push(id)
  await db.profiles.create({ data: { id, name: `Test ${label}`, onboarded: true } })
  const { email } = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
  return { id, token: signAccessToken(id, email) }
}

const req = (method: string, url: string, token: string, body?: object) =>
  new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

const create = (who: Person, eventId: string, body: object) =>
  boardRoute.POST(req("POST", `/api/mobile/events/${eventId}/board`, who.token, body), { params: Promise.resolve({ eventId }) })
const list = async (who: Person, eventId: string, query = "") => {
  const res = await boardRoute.GET(req("GET", `/api/mobile/events/${eventId}/board${query}`, who.token), { params: Promise.resolve({ eventId }) })
  return { status: res.status, json: await res.json(), text: "" }
}
const raw = async (res: Response) => {
  const text = await res.text()
  return { status: res.status, text, json: JSON.parse(text) }
}

/** What storage holds at the upload's key: a phone photo, its GPS block and all. */
function storageHoldsTheUpload() {
  mockSend.mockReset()
  mockSend.mockImplementation(async (command: unknown) => {
    if (command instanceof HeadObjectCommand) return { ContentLength: bytesOf(JPEG_WITH_GPS).length, ContentType: "image/jpeg" }
    if (command instanceof GetObjectCommand) return { Body: { transformToByteArray: async () => bytesOf(JPEG_WITH_GPS) } }
    return {}
  })
}
const uploadOf = (who: Person) => `https://blendn-media-test-private.fly.storage.tigris.dev/chat/${who.id}/1790641297767-cfg6ta-photo.jpg`

describe("types and spots", () => {
  it("stores what an offer or a search is about, and refuses one that does not fit", async () => {
    const eventId = await upcoming()
    const me = await poster("lob-types", eventId)

    const ride = await create(me, eventId, { kind: "offer", subKind: "ride", body: "Driving from HSR at 5", spacesLeft: 3 })
    expect(ride.status).toBe(201)
    expect((await ride.json()).data).toMatchObject({ kind: "offer", subKind: "ride", spacesLeft: 3, photo: null })

    for (const bad of [
      { kind: "seeking", subKind: "spots", body: "x" },
      { kind: "chat", subKind: "ride", body: "x" },
      { kind: "offer", subKind: "buddy", body: "x" },
    ]) {
      expect((await create(me, eventId, bad)).status).toBe(400)
    }
    // The database holds the same table, whoever writes.
    await expect(db.board_posts.create({ data: { event_id: eventId, author_id: me.id, kind: "seeking", sub_kind: "spots", body: "x" } })).rejects.toThrow(/board_posts_sub_kind_fits/)
    await expect(db.board_posts.create({ data: { event_id: eventId, author_id: me.id, kind: "chat", sub_kind: "ride", body: "x" } })).rejects.toThrow(/board_posts_sub_kind_fits/)
  })

  it("counts a post's body and an ask's message in characters, as a person (and char_length) does: an emoji is one", async () => {
    const eventId = await upcoming()
    const me = await poster("lob-chars", eventId)
    const asker = await poster("lob-chars-ask", eventId)

    const full = await create(me, eventId, { kind: "offer", subKind: "ride", body: "🚗".repeat(500), spacesLeft: 2 })
    expect(full.status).toBe(201)
    const { id: postId } = (await full.json()).data
    expect((await create(me, eventId, { kind: "chat", body: "🚗".repeat(501) })).status).toBe(400)

    const ask = (message: string) =>
      requestsRoute.POST(req("POST", `/api/mobile/events/${eventId}/board/${postId}/requests`, asker.token, { message }), { params: Promise.resolve({ eventId, postId }) })
    expect((await ask("🙋".repeat(301))).status).toBe(400)
    expect((await ask("🙋".repeat(300))).status).toBe(201)
    const [row] = await db.$queryRaw<{ n: number }[]>`SELECT char_length(message)::int AS n FROM board_requests WHERE post_id = ${postId}::uuid`
    expect(row.n).toBe(300)
  })

  it("counts a spare ticket as one left, and keeps the field name installed builds read (`spacesLeft`)", async () => {
    const eventId = await upcoming()
    const me = await poster("lob-ticket", eventId)
    const res = await create(me, eventId, { kind: "offer", subKind: "ticket", body: "Friend bailed, face value" })
    expect((await res.json()).data).toMatchObject({ subKind: "ticket", spacesLeft: 1 })
  })

  it("hides spare tickets and looking-for-a-ticket on an event whose tickets are sold here, and only there", async () => {
    const eventId = await upcoming()
    const me = await poster("lob-native", eventId)
    const reader = await poster("lob-native-r", eventId)
    // Posted before ticketing came on, as an old row would be.
    const old = await db.board_posts.create({ data: { event_id: eventId, author_id: me.id, kind: "seeking", sub_kind: "ticket", body: "Anyone got one?" }, select: { id: true } })
    const market = await db.markets.findUniqueOrThrow({ where: { code: "IN" } })
    await db.events.update({
      where: { id: eventId },
      data: { ticketing_mode: "native", ticketing_enabled_at: new Date(), ticket_fee_rule: "standard", ticket_fee_schedule: feeScheduleFromMarket(market as MarketFeeRow, new Date()) },
    })

    const before = process.env.TICKETING
    process.env.TICKETING = "true"
    try {
      const refused = await create(me, eventId, { kind: "offer", subKind: "ticket", body: "Spare" })
      expect(refused.status).toBe(422)
      expect((await refused.json()).reasonCode).toBe("LOBBY_TICKETS_HIDDEN")
      const page = await list(reader, eventId)
      expect(page.json.data.ticketsHidden).toBe(true)
      expect(page.json.data.subKinds).toEqual({ offer: ["ride", "spots"], seeking: ["ride", "buddy"], chat: [] })
      expect(page.json.data.posts.map((p: { id: string }) => p.id)).not.toContain(old.id)
    } finally {
      process.env.TICKETING = before
    }
    // Control: with ticketing off the same post is there.
    expect((await list(reader, eventId)).json.data.posts.map((p: { id: string }) => p.id)).toContain(old.id)
  })
})

describe("a photo", () => {
  let eventId = ""
  let author: Person
  let reader: Person
  let postId = ""
  let sealedKey = ""

  beforeAll(async () => {
    eventId = await upcoming()
    author = await poster("lob-photo-a", eventId)
    reader = await poster("lob-photo-r", eventId)
  })

  it("is stored as the server's own copy with its location stripped, pending", async () => {
    storageHoldsTheUpload()
    const res = await create(author, eventId, { kind: "chat", body: "The fit for tonight", photo: { url: uploadOf(author), alt: "A green jacket on a chair" } })
    expect(res.status).toBe(201)
    const post = (await res.json()).data
    postId = post.id
    expect(post.photo).toMatchObject({ status: "pending", alt: "A green jacket on a chair" })

    const put = mockSend.mock.calls.map(([c]) => c).find((c): c is PutObjectCommand => c instanceof PutObjectCommand)!
    sealedKey = put.input.Key as string
    expect(sealedKey).toMatch(/^chat\/sealed\/[0-9a-f-]{36}$/)
    const stored = put.input.Body as Uint8Array
    for (const marker of METADATA) expect(has(stored, marker)).toBe(false)
    // Control: the upload had them.
    expect(has(bytesOf(JPEG_WITH_GPS), "GPSLatitude")).toBe(true)

    const row = await db.board_posts.findUniqueOrThrow({ where: { id: postId }, select: { photo_url: true, photo_status: true } })
    expect(row).toEqual({ photo_url: expect.stringContaining(sealedKey), photo_status: "pending" })
  })

  it("while pending, is shown to its author and to nobody else, whose response never holds its URL", async () => {
    const mine = await list(author, eventId)
    expect(mine.json.data.posts.find((p: { id: string }) => p.id === postId).photo).toMatchObject({ status: "pending", url: expect.stringContaining(sealedKey) })

    const theirs = await raw(await boardRoute.GET(req("GET", `/api/mobile/events/${eventId}/board`, reader.token), { params: Promise.resolve({ eventId }) }))
    expect(theirs.json.data.posts.find((p: { id: string }) => p.id === postId).photo).toBeNull()
    expect(theirs.text).not.toContain(sealedKey)
    // Nor through a post link, nor the preview.
    const one = await raw(await postRoute.GET(req("GET", `/x`, reader.token), { params: Promise.resolve({ eventId, postId }) }))
    expect(one.json.data.post.photo).toBeNull()
    expect(one.text).not.toContain(sealedKey)
    const preview = await raw(await previewRoute.GET(req("GET", `/x`, reader.token), { params: Promise.resolve({ eventId }) }))
    expect(preview.text).not.toContain(sealedKey)
  })

  it("stays pending when moderation could not look, and is shown to everybody once it passes", async () => {
    expect(await moderateLobbyPhoto(postId, async () => ({ checked: false, reason: "timeout" }))).toBeNull()
    expect((await db.board_posts.findUniqueOrThrow({ where: { id: postId } })).photo_status).toBe("pending")

    expect(await moderateLobbyPhoto(postId, async () => ({ checked: true, result: null }))).toBe("approved")
    const theirs = await list(reader, eventId)
    expect(theirs.json.data.posts.find((p: { id: string }) => p.id === postId).photo).toMatchObject({ status: "approved", url: expect.stringContaining(sealedKey) })
    // A second verdict changes nothing: only a pending photo is judged.
    expect(await moderateLobbyPhoto(postId, async () => ({ checked: true, result: { action: "hide", source: "openai_image", categories: {}, confidence: 1 } }))).toBeNull()
  })

  it("rejected — a flag counts — is shown to nobody but its author, as rejected and without a URL, and kept", async () => {
    storageHoldsTheUpload()
    const res = await create(author, eventId, { kind: "chat", body: "Another one", photo: { url: uploadOf(author) } })
    const id = (await res.json()).data.id
    expect(await moderateLobbyPhoto(id, async () => ({ checked: true, result: { action: "flag", source: "openai_image", categories: {}, confidence: 0.6 } }))).toBe("rejected")

    expect((await list(author, eventId)).json.data.posts.find((p: { id: string }) => p.id === id).photo).toEqual({ status: "rejected", url: null, alt: null })
    expect((await list(reader, eventId)).json.data.posts.find((p: { id: string }) => p.id === id).photo).toBeNull()
    const row = await db.board_posts.findUniqueOrThrow({ where: { id }, select: { photo_url: true, photo_checked_at: true } })
    expect(row.photo_url).not.toBeNull()
    expect(row.photo_checked_at).not.toBeNull()
  })

  it("is judged by the sweep when its own check never landed, oldest first, and not before two minutes", async () => {
    const at = new Date()
    const young = await db.board_posts.create({ data: { event_id: eventId, author_id: author.id, kind: "chat", body: "y", photo_url: `https://blendn-media-test-private.fly.storage.tigris.dev/chat/sealed/${crypto.randomUUID()}`, photo_status: "pending" }, select: { id: true } })
    const stale = await db.board_posts.create({ data: { event_id: eventId, author_id: author.id, kind: "chat", body: "s", photo_url: `https://blendn-media-test-private.fly.storage.tigris.dev/chat/sealed/${crypto.randomUUID()}`, photo_status: "pending", created_at: new Date(at.getTime() - 3 * 60_000) }, select: { id: true } })
    expect(await recheckPendingPhotos(at, async () => ({ checked: true, result: null }))).toBeGreaterThanOrEqual(1)
    expect((await db.board_posts.findUniqueOrThrow({ where: { id: stale.id } })).photo_status).toBe("approved")
    expect((await db.board_posts.findUniqueOrThrow({ where: { id: young.id } })).photo_status).toBe("pending")
  })

  it("refuses somebody else's upload, or any other URL, and stores nothing", async () => {
    const before = await db.board_posts.count({ where: { event_id: eventId } })
    for (const url of [uploadOf(reader), "https://example.com/cat.jpg"]) {
      expect((await create(author, eventId, { kind: "chat", body: "x", photo: { url } })).status).toBe(400)
    }
    expect(await db.board_posts.count({ where: { event_id: eventId } })).toBe(before)
  })

  it("caps alt text, in the request and in the database", async () => {
    storageHoldsTheUpload()
    expect((await create(author, eventId, { kind: "chat", body: "x", photo: { url: uploadOf(author), alt: "a".repeat(201) } })).status).toBe(400)
    await expect(db.board_posts.update({ where: { id: postId }, data: { photo_alt: "a".repeat(201) } })).rejects.toThrow(/board_posts_photo_alt_fits/)
    // In characters, as the CHECK counts: 200 emoji are 200, not 400.
    expect((await create(author, eventId, { kind: "chat", body: "x", photo: { url: uploadOf(author), alt: "📸".repeat(201) } })).status).toBe(400)
    storageHoldsTheUpload()
    const fits = await create(author, eventId, { kind: "chat", body: "x", photo: { url: uploadOf(author), alt: "📸".repeat(200) } })
    expect(fits.status).toBe(201)
    const [row] = await db.$queryRaw<{ n: number }[]>`SELECT char_length(photo_alt)::int AS n FROM board_posts WHERE id = ${(await fits.json()).data.id}::uuid`
    expect(row.n).toBe(200)
  })
})

describe("filters, counts and the first page", () => {
  it("filters on the server, counts each chip, and carries the composer's state", async () => {
    const eventId = await upcoming()
    const me = await poster("lob-f-me", eventId)
    const other = await poster("lob-f-other", eventId)
    const mine = await db.board_posts.create({ data: { event_id: eventId, author_id: me.id, kind: "seeking", sub_kind: "ride", body: "Need a ride" }, select: { id: true } })
    const ride = await db.board_posts.create({ data: { event_id: eventId, author_id: other.id, kind: "offer", sub_kind: "ride", body: "Car", spaces_left: 2 }, select: { id: true } })
    await db.board_posts.create({ data: { event_id: eventId, author_id: other.id, kind: "chat", body: "Hello" } })
    // An ask on my post, and my ask the other said yes to.
    await db.board_requests.create({ data: { event_id: eventId, post_id: mine.id, from_user_id: other.id, to_user_id: me.id } })
    await db.board_requests.create({ data: { event_id: eventId, post_id: ride.id, from_user_id: me.id, to_user_id: other.id, status: "accepted", decided_at: new Date() } })

    const page = await list(me, eventId)
    expect(page.json.data.counts).toEqual({ all: 3, offer: 1, seeking: 1, chat: 1, offerRides: 1, mine: 1, replies: 2 })
    expect(page.json.data.compose).toEqual({ allowed: true, message: null, reasonCode: null })
    expect(page.json.data.state).toBe("open")
    // Your own room name, for "Posting as": the handle your posts go up under, and nobody else's.
    const myPost = (await list(me, eventId, "?filter=mine")).json.data.posts[0]
    expect(page.json.data.you).toEqual({ pseudonym: myPost.author })
    expect(typeof myPost.author).toBe("string")
    expect((await list(other, eventId)).json.data.you.pseudonym).not.toBe(myPost.author)
    // Later pages are posts only.
    const firstOfOne = (await list(me, eventId, "?limit=1")).json.data
    expect(firstOfOne.you).toBeDefined()
    expect((await list(me, eventId, `?limit=1&cursor=${firstOfOne.pagination.nextCursor}`)).json.data.you).toBeUndefined()

    const ids = async (q: string) => (await list(me, eventId, q)).json.data.posts.map((p: { id: string }) => p.id).sort()
    expect(await ids("?kind=offer")).toEqual([ride.id])
    expect(await ids("?filter=mine")).toEqual([mine.id])
    expect(await ids("?filter=replies")).toEqual([mine.id, ride.id].sort())
    expect((await list(me, eventId, "?filter=everyone")).status).toBe(400)

    // Somebody not going reads, and is told why they cannot post.
    const saver = await outsider("lob-f-saver")
    await db.event_favorites.create({ data: { event_id: eventId, user_id: saver.id } })
    expect((await list(saver, eventId)).json.data.compose).toMatchObject({ allowed: false, reasonCode: "BOARD_NOT_GOING" })
  })
})

describe("the event page's preview", () => {
  it("gives counts to anybody, and posts only to somebody who saved or is going", async () => {
    const eventId = await upcoming()
    const me = await poster("lob-p-me", eventId)
    for (const body of ["one", "two", "three"]) await db.board_posts.create({ data: { event_id: eventId, author_id: me.id, kind: "offer", sub_kind: "ride", body } })

    const mine = (await (await previewRoute.GET(req("GET", "/x", me.token), { params: Promise.resolve({ eventId }) })).json()).data
    expect(mine).toMatchObject({ canRead: true, counts: { all: 3, offerRides: 3 } })
    expect(mine.latest.map((p: { body: string }) => p.body)).toEqual(["three", "two"])

    const stranger = await outsider("lob-p-stranger")
    const theirs = (await (await previewRoute.GET(req("GET", "/x", stranger.token), { params: Promise.resolve({ eventId }) })).json()).data
    expect(theirs).toMatchObject({ canRead: false, counts: { all: 3 }, latest: [] })
  })
})

describe("From the Lobby", () => {
  it("lists the posts you are in through an accepted ask, either way, with the host's note", async () => {
    const eventId = await upcoming()
    const author = await poster("lob-s-a", eventId)
    const asker = await poster("lob-s-b", eventId)
    const post = await db.board_posts.create({ data: { event_id: eventId, author_id: author.id, kind: "offer", sub_kind: "ride", body: "From Indiranagar at 5:30", spaces_left: 2 }, select: { id: true } })
    const ask = await db.board_requests.create({ data: { event_id: eventId, post_id: post.id, from_user_id: asker.id, to_user_id: author.id, status: "accepted", decided_at: new Date() }, select: { id: true } })
    await db.board_host_posts.create({ data: { event_id: eventId, body: "Doors at 6 sharp. Side lane." } })

    const forAsker = (await (await summaryRoute.GET(req("GET", "/x", asker.token), { params: Promise.resolve({ eventId }) })).json()).data
    expect(forAsker.joined).toEqual([expect.objectContaining({ postId: post.id, mine: false, others: 1, requestId: ask.id, chatGroupId: null, conversationId: null })])
    // The 1:1 the accept opened is named on the row, so the room's card can open it.
    const [user1_id, user2_id] = [asker.id, author.id].sort()
    const dm = await db.private_conversations.create({ data: { user1_id, user2_id, origin_board_request_id: ask.id }, select: { id: true } })
    const withDm = (await (await summaryRoute.GET(req("GET", "/x", asker.token), { params: Promise.resolve({ eventId }) })).json()).data
    expect(withDm.joined[0]).toMatchObject({ requestId: ask.id, conversationId: dm.id })
    expect(forAsker.pinned).toMatchObject({ body: "Doors at 6 sharp. Side lane.", host: "Organizer" })
    const forAuthor = (await (await summaryRoute.GET(req("GET", "/x", author.token), { params: Promise.resolve({ eventId }) })).json()).data
    expect(forAuthor.joined).toEqual([expect.objectContaining({ postId: post.id, mine: true, others: 1, requestId: null, conversationId: null })])
    await db.private_conversations.delete({ where: { id: dm.id } })

    const stranger = await outsider("lob-s-c")
    expect((await summaryRoute.GET(req("GET", "/x", stranger.token), { params: Promise.resolve({ eventId }) })).status).toBe(403)
  })
})

describe("a live event whose Lobby nobody posted in (owner, 2026-11-06)", () => {
  async function liveEmpty() {
    const eventId = await upcoming()
    // An hour before the start: past doors, so the room is open and the Lobby read-only.
    const start = new Date(Date.now() + 3_600_000)
    await db.events.update({ where: { id: eventId }, data: { start_time: start, end_time: new Date(start.getTime() + 3 * 3_600_000) } })
    return { eventId, me: await poster("lob-empty", eventId) }
  }
  const at = (route: { GET: (r: NextRequest, c: { params: Promise<{ eventId: string }> }) => Promise<Response> }, who: Person, eventId: string) =>
    route.GET(req("GET", "/x", who.token), { params: Promise.resolve({ eventId }) })

  it("reads empty and live, with zero counts and a read-only composer", async () => {
    const { eventId, me } = await liveEmpty()
    const page = await list(me, eventId)
    expect(page.status).toBe(200)
    expect(page.json.data).toMatchObject({ state: "read_only", phase: "live", posts: [], pinned: null, counts: { all: 0, offer: 0, seeking: 0, chat: 0, offerRides: 0, mine: 0, replies: 0 } })
    expect(page.json.data.compose).toMatchObject({ allowed: false, reasonCode: "LOBBY_READ_ONLY" })

    const preview = await at(previewRoute, me, eventId)
    expect(preview.status).toBe(200)
    expect((await preview.json()).data).toMatchObject({ phase: "live", canRead: true, latest: [], counts: { all: 0, offerRides: 0 } })
  })

  it("gives the room no card at all: hasContent false, and no empty card payload", async () => {
    const { eventId, me } = await liveEmpty()
    const res = await at(summaryRoute, me, eventId)
    expect(res.status).toBe(200)
    const data = (await res.json()).data
    expect(data).toEqual({ state: "read_only", phase: "live", readUntil: expect.any(String), hasContent: false })
  })

  it("is just the host's note when that is all there is", async () => {
    const { eventId, me } = await liveEmpty()
    await db.board_host_posts.create({ data: { event_id: eventId, body: "Doors at 6. Side lane." } })
    const data = (await (await at(summaryRoute, me, eventId)).json()).data
    expect(data).toMatchObject({ phase: "live", hasContent: true, pinned: { body: "Doors at 6. Side lane." }, joined: [], asks: { yours: 0, waitingOnYou: 0 } })
    expect((await list(me, eventId)).json.data).toMatchObject({ phase: "live", posts: [], pinned: { body: "Doors at 6. Side lane." } })
  })

  it("is before, not live, while the Lobby is open (the control)", async () => {
    const eventId = await upcoming()
    const me = await poster("lob-empty-before", eventId)
    expect((await list(me, eventId)).json.data.phase).toBe("before")
  })
})

describe("alerts", () => {
  it("are all off until turned on, per event, and only the keys sent change", async () => {
    const eventId = await upcoming()
    const me = await poster("lob-al", eventId)
    const at = (body?: object) => (body ? alertsRoute.PUT(req("PUT", "/x", me.token, body), { params: Promise.resolve({ eventId }) }) : alertsRoute.GET(req("GET", "/x", me.token), { params: Promise.resolve({ eventId }) }))

    expect((await (await at()).json()).data).toEqual({ offersMatch: false, replies: false, hostPosts: false })
    expect((await (await at({ replies: true })).json()).data).toEqual({ offersMatch: false, replies: true, hostPosts: false })
    expect((await (await at({ hostPosts: true })).json()).data).toEqual({ offersMatch: false, replies: true, hostPosts: true })
    expect((await at({ everything: true })).status).toBe(400)
  })

  it("send an ask and a yes always (person to person), and gate only the discovery alerts on the switch for that event", async () => {
    const eventId = await upcoming()
    const elsewhere = await upcoming()
    const me = await poster("lob-gate", eventId)
    await db.push_tokens.create({ data: { user_id: me.id, token: `ExponentPushToken[${testId("t")}]`, platform: "ios" } })
    const reachable = (data: Parameters<typeof pushGates>[0]) => db.push_tokens.count({ where: { user_id: me.id, ...pushGates(data) } })

    // An ask on your post and a yes to yours: on with no switches at all (owner, 2026-11-06).
    expect(await reachable({ type: "board_request", eventId })).toBe(1)
    expect(await reachable({ type: "board_request_accepted", eventId })).toBe(1)
    // The discovery alerts: off until turned on, for this event only.
    for (const type of ["board_match", "board_host_post"] as const) expect(await reachable({ type, eventId })).toBe(0)
    await db.board_alert_preferences.create({ data: { user_id: me.id, event_id: elsewhere, offers_match: true, host_posts: true } })
    for (const type of ["board_match", "board_host_post"] as const) expect(await reachable({ type, eventId })).toBe(0)
    await db.board_alert_preferences.create({ data: { user_id: me.id, event_id: eventId, offers_match: true, host_posts: true } })
    for (const type of ["board_match", "board_host_post"] as const) expect(await reachable({ type, eventId })).toBe(1)
    expect(await reachable({ type: "board_match" })).toBe(0)
    // The account's own "matches" switch still silences an ask, as it did before the Lobby.
    await db.profiles.update({ where: { id: me.id }, data: { push_matches: false } })
    expect(await reachable({ type: "board_request", eventId })).toBe(0)
    expect(await reachable({ type: "board_request_accepted", eventId })).toBe(0)
    await db.profiles.update({ where: { id: me.id }, data: { push_matches: true } })
    // Control: a kind with no Lobby switch is untouched by it.
    expect(await reachable({ type: "friend_request" })).toBe(1)
    await db.push_tokens.deleteMany({ where: { user_id: me.id } })
  })

  it("send a match to people looking for what is offered who asked to hear, and never across a block or a friendship", async () => {
    const eventId = await upcoming()
    const offerer = await poster("lob-m-o", eventId)
    const [wants, quiet, blocked, friend, wrongKind] = await Promise.all(["w", "q", "b", "f", "k"].map((l) => poster(`lob-m-${l}`, eventId)))
    for (const p of [wants, quiet, blocked, friend]) await db.board_posts.create({ data: { event_id: eventId, author_id: p.id, kind: "seeking", sub_kind: "ride", body: "Need a ride" } })
    await db.board_posts.create({ data: { event_id: eventId, author_id: wrongKind.id, kind: "seeking", sub_kind: "buddy", body: "Anyone?" } })
    for (const p of [wants, blocked, friend, wrongKind]) await db.board_alert_preferences.create({ data: { user_id: p.id, event_id: eventId, offers_match: true } })
    await db.blocked_users.create({ data: { blocker_id: blocked.id, blocked_id: offerer.id } })
    const [u1, u2] = [offerer.id, friend.id].sort()
    await db.friendships.create({ data: { user1_id: u1, user2_id: u2 } })

    expect(await matchRecipients({ event_id: eventId, author_id: offerer.id, sub_kind: "ride" })).toEqual([wants.id])
    expect(await matchRecipients({ event_id: eventId, author_id: offerer.id, sub_kind: "spots" })).toEqual([wrongKind.id])
    await db.friendships.deleteMany({ where: { user1_id: u1, user2_id: u2 } })
    await db.blocked_users.deleteMany({ where: { blocker_id: blocked.id } })
  })
})

describe("one lifecycle", () => {
  it("closes a post's room for reading a day after the end, with the event's room; the asks go from the list", async () => {
    const eventId = await upcoming()
    const author = await poster("lob-l-a", eventId)
    const asker = await poster("lob-l-b", eventId)
    const post = await db.board_posts.create({ data: { event_id: eventId, author_id: author.id, kind: "offer", body: "Car", spaces_left: 2 }, select: { id: true } })
    await db.board_requests.create({ data: { event_id: eventId, post_id: post.id, from_user_id: asker.id, to_user_id: author.id, status: "accepted", decided_at: new Date() } })
    const room = await db.chat_groups.create({ data: { kind: "board_post", board_post_id: post.id, name: "Car", status: "active" }, select: { id: true } })
    await db.chat_group_members.create({ data: { chat_group_id: room.id, user_id: author.id, status: "active" } })
    await db.chat_groups.create({ data: { event_id: eventId, name: "room", status: "active" } })
    await db.chat_group_members.create({ data: { chat_group_id: (await db.chat_groups.findUniqueOrThrow({ where: { event_id: eventId } })).id, user_id: author.id, status: "left" } })

    const endedAgo = (ms: number) => db.events.update({ where: { id: eventId }, data: { start_time: new Date(Date.now() - ms - 3_600_000), end_time: new Date(Date.now() - ms) } })
    const readRoom = () => messagesRoute.GET(req("GET", `/x`, author.token), { params: Promise.resolve({ chatGroupId: room.id }) })
    const readEventRoom = () => eventChat.GET(req("GET", `/x`, author.token), { params: Promise.resolve({ eventId }) })
    const asksListed = async () => (await (await myRequests.GET(req("GET", "/x", asker.token))).json()).data.outgoing.length

    // Thirteen hours after the end: the post's room used to have closed at twelve; open now.
    await endedAgo(13 * 3_600_000)
    expect((await readRoom()).status).toBe(200)
    expect((await readEventRoom()).status).toBe(200)
    expect(await asksListed()).toBe(1)

    await endedAgo(24 * 3_600_000)
    const closedRoom = await readRoom()
    expect(closedRoom.status).toBe(404)
    expect(await closedRoom.json()).toMatchObject({ reasonCode: "ROOM_CLOSED" })
    const closedEventRoom = await readEventRoom()
    expect(closedEventRoom.status).toBe(403)
    expect(await closedEventRoom.json()).toMatchObject({ errorCode: "CHAT_CLOSED", reasonCode: "ROOM_CLOSED" })
    expect(await asksListed()).toBe(0)
    // Kept server-side: nothing was deleted by closing.
    expect(await db.board_posts.count({ where: { id: post.id } })).toBe(1)
  })
})
