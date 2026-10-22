/**
 * What a bell row can say for the person reading it (Flow 9 · 9.2, 9.3): the
 * `display` visual, `open` for a request still waiting, `data.reason` on an
 * event update, `data.notificationId` on the push, and the app-icon
 * `badgeCount`. Real handlers, real rows.
 *
 * Every old field of an item is asserted where it was.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
type Msg = { to: string; data: Record<string, string> }
const sentMessages: Msg[] = []
jest.mock("expo-server-sdk", () => {
  class Expo {
    static isExpoPushToken(t: string) {
      return t.startsWith("ExponentPushToken[")
    }
    chunkPushNotifications(m: unknown[]) {
      return [m]
    }
    async sendPushNotificationsAsync(chunk: Msg[]) {
      sentMessages.push(...chunk)
      return chunk.map(() => ({ status: "ok", id: "t" }))
    }
  }
  return { Expo }
})

// Decoration can be made to fail, to prove the bell does not go with it.
const mockDecoration = { fail: false }
jest.mock("@/lib/notification-display", () => {
  const actual = jest.requireActual("@/lib/notification-display")
  return {
    ...actual,
    decorateNotifications: (...a: unknown[]) =>
      mockDecoration.fail ? Promise.reject(new Error("decoration exploded")) : actual.decorateNotifications(...a),
  }
})

import { randomUUID } from "crypto"
import { signAccessToken } from "@/lib/mobile-auth"
import { notifyEventChanged, notifyEventUpdate, sendBulkPushNotifications, sendPushNotification } from "@/lib/push-notifications"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"
import { req } from "./go-live-world"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const feed = require("@/app/api/mobile/notifications/route") as typeof import("@/app/api/mobile/notifications/route")

const users: string[] = []
const events: string[] = []
const crews: string[] = []
const tokenOf = (id: string) => signAccessToken(id, `${id}@itest.invalid`)

async function person(label: string, photo?: string) {
  const id = await makeUser(testId(label))
  users.push(id)
  await db.profiles.upsert({ where: { id }, create: { id, name: `Person ${label}`, onboarded: true, ...(photo && { photos: [photo] }) }, update: {} })
  return id
}

interface Row {
  id: string
  kind: string
  data: Record<string, unknown> | null
  open?: boolean
  display: { title?: string; visual?: Record<string, unknown> }
}

const items = async (viewer: string) => {
  const res = await feed.GET(req("/api/mobile/notifications", tokenOf(viewer)))
  return { status: res.status, data: (await res.json()).data as { notifications: Row[]; unreadCount: number; badgeCount: number } }
}
const rowOf = async (viewer: string, kind: string) => (await items(viewer)).data.notifications.find((n) => n.kind === kind)!

beforeEach(() => {
  sentMessages.length = 0
  mockDecoration.fail = false
})

afterAll(async () => {
  await db.board_requests.deleteMany({ where: { event_id: { in: events } } })
  await db.board_posts.deleteMany({ where: { event_id: { in: events } } })
  await db.message_requests.deleteMany({ where: { OR: [{ sender_id: { in: users } }, { recipient_id: { in: users } }] } })
  await db.crew_members.deleteMany({ where: { crew_id: { in: crews } } })
  await db.crew_invites.deleteMany({ where: { crew_id: { in: crews } } })
  await db.crews.deleteMany({ where: { id: { in: crews } } })
  await db.notifications.deleteMany({ where: { user_id: { in: users } } })
  await db.push_tokens.deleteMany({ where: { user_id: { in: users } } })
  await db.friend_requests.deleteMany({ where: { OR: [{ sender_id: { in: users } }, { recipient_id: { in: users } }] } })
  await db.private_messages.deleteMany({ where: { sender_id: { in: users } } })
  await cleanup(users, events)
  await closeDb()
}, 60_000)

describe("friend_request rows", () => {
  it("name and show the asker while the request waits; open flips to false when it is gone", async () => {
    const asker = await person("nf-asker", "https://cdn.test/profile/a/1.jpg")
    const me = await person("nf-me")
    const request = await db.friend_requests.create({ data: { sender_id: asker, recipient_id: me } })
    await sendPushNotification({ userId: me, title: "New friend request", body: "Someone wants to be friends.", data: { type: "friend_request", requestId: request.id } })

    const row = await rowOf(me, "friend_request")
    // What was there.
    expect(row).toMatchObject({ kind: "friend_request", title: "New friend request", body: "Someone wants to be friends.", readAt: null })
    expect(row.data).toEqual({ type: "friend_request", requestId: request.id })
    // What is new.
    expect(row.open).toBe(true)
    expect(row.display.title).toMatch(/wants to be friends$/)
    expect(row.display.visual).toEqual({ type: "photo", uri: expect.stringContaining("a/1.jpg") })

    // "Not now": hidden, and no longer waiting.
    await db.friend_requests.update({ where: { id: request.id }, data: { dismissed_at: new Date() } })
    const gone = await rowOf(me, "friend_request")
    expect(gone.open).toBe(false)
    expect(gone).not.toHaveProperty("display")
  })

  it("someone else's request id gives the reader nothing", async () => {
    const asker = await person("nf-a2")
    const other = await person("nf-other")
    const me = await person("nf-me2")
    const request = await db.friend_requests.create({ data: { sender_id: asker, recipient_id: other } })
    await sendPushNotification({ userId: me, title: "t", body: "b", data: { type: "friend_request", requestId: request.id } })
    const row = await rowOf(me, "friend_request")
    expect(row.open).toBe(false)
    expect(JSON.stringify(row)).not.toContain(asker)
  })
})

describe("crew rows", () => {
  it("an invite is open until it is declined; a crew's emblem is its id and no text", async () => {
    const owner = await person("nf-owner")
    const me = await person("nf-invitee")
    const crew = await db.crews.create({ data: { name: "Nebula", created_by: owner, emblem_seed: "seed-nebula" } as never })
    crews.push(crew.id)
    const invite = await db.crew_invites.create({ data: { crew_id: crew.id, invited_user_id: me, invited_by: owner } })
    await sendPushNotification({ userId: me, title: "t", body: "b", data: { type: "crew_invite", crewId: crew.id } })

    const open = await rowOf(me, "crew_invite")
    expect(open.open).toBe(true)
    expect(open.display).toEqual({ visual: { type: "emblem", seed: "seed-nebula" } })
    expect(JSON.stringify(open)).not.toContain("Nebula")

    await db.crew_invites.update({ where: { id: invite.id }, data: { declined_at: new Date() } })
    expect((await rowOf(me, "crew_invite")).open).toBe(false)
  })
})

describe("match rows", () => {
  it("show the other side's room pseudonym, never a name or a photo", async () => {
    const me = await person("nf-m1")
    const them = await person("nf-m2", "https://cdn.test/profile/m/2.jpg")
    const [user1_id, user2_id] = [me, them].sort()
    const convo = await db.private_conversations.create({
      data: { user1_id, user2_id, user1_pseudonym: user1_id === me ? "Quiet Otter" : "Amber Fox", user2_pseudonym: user2_id === me ? "Quiet Otter" : "Amber Fox" },
    })
    await sendPushNotification({ userId: me, title: "t", body: "b", data: { type: "match", conversationId: convo.id } })
    const row = await rowOf(me, "match")
    expect(row.display).toEqual({ visual: { type: "creature", pseudonym: "Amber Fox" } })
    expect(JSON.stringify(row)).not.toContain("m/2.jpg")
    await db.private_conversations.delete({ where: { id: convo.id } })
  })
})

describe("event rows", () => {
  it("event_update carries data.reason in the stored row and the push; the tile is the event's cover and badge", async () => {
    const host = await person("nf-host")
    const me = await person("nf-goer")
    await db.push_tokens.create({ data: { user_id: me, token: `ExponentPushToken[${me}]`, platform: "ios" } })
    const eventId = await makeEvent(host)
    events.push(eventId)
    await db.events.update({ where: { id: eventId }, data: { cover_image_url: "https://cdn.test/cover/e.jpg" } })

    await notifyEventUpdate([me], "Night", "Event updated: venue", eventId, "venue", "venue")
    const row = await rowOf(me, "event_update")
    expect(row.data).toEqual({ type: "event_update", eventId, reason: "venue", changed: "venue" })
    expect(row.display.visual).toEqual({ type: "event", cover: expect.stringContaining("e.jpg"), badge: "map-pin", cancelled: false })
    // The push carries the row's own id so a banner can open it.
    expect(sentMessages[0].data.notificationId).toBe(row.id)
    expect(sentMessages[0].data.reason).toBe("venue")
    // The stored row never holds its own id.
    expect(row.data).not.toHaveProperty("notificationId")
  })

  it("when several things moved the reason is the one that matters most; a reminder carries none", async () => {
    const host = await person("nf-host2")
    const me = await person("nf-goer2")
    const eventId = await makeEvent(host)
    events.push(eventId)
    await notifyEventChanged([me], "Night", "Event updated", eventId, "venue,time")
    expect((await rowOf(me, "event_changed")).data).toMatchObject({ reason: "time", changed: "venue,time" })

    await notifyEventUpdate([me], "Night", "Starts in an hour", eventId)
    const reminder = (await items(me)).data.notifications.find((n) => n.kind === "event_update")!
    expect(reminder.data).toEqual({ type: "event_update", eventId })

    await db.events.update({ where: { id: eventId }, data: { status: "cancelled" } })
    expect((await rowOf(me, "event_update")).display.visual).toMatchObject({ cancelled: true })
  })
})

describe("the bulk push carries each recipient's own row id", () => {
  it("different ids to different people, and each is that person's row", async () => {
    const a = await person("nf-b1")
    const b = await person("nf-b2")
    for (const id of [a, b]) await db.push_tokens.create({ data: { user_id: id, token: `ExponentPushToken[${id}]`, platform: "ios" } })
    await sendBulkPushNotifications({ userIds: [a, b], title: "t", body: "b", data: { type: "announcement", eventId: "e1" } })

    for (const id of [a, b]) {
      const push = sentMessages.find((m) => m.to === `ExponentPushToken[${id}]`)!
      const stored = await db.notifications.findFirstOrThrow({ where: { user_id: id } })
      expect(push.data.notificationId).toBe(stored.id)
    }
    expect(new Set(sentMessages.map((m) => m.data.notificationId)).size).toBe(2)
  })
})

describe("badgeCount", () => {
  it("is unseen bell rows plus conversations with something unread, and clearKeepsRequests stays absent", async () => {
    const me = await person("nf-badge")
    const them = await person("nf-badge2")
    await sendPushNotification({ userId: me, title: "t", body: "b", data: { type: "announcement", eventId: "e1" } })
    await sendPushNotification({ userId: me, title: "t", body: "b", data: { type: "blend", blendId: "b1" } })

    const [user1_id, user2_id] = [me, them].sort()
    const one = await db.private_conversations.create({ data: { user1_id, user2_id } })
    const send = (text: string, extra: object = {}) =>
      db.private_messages.create({ data: { conversation_id: one.id, sender_id: them, message_text: text, ...extra } })
    await send("one")
    await send("two") // two unread messages are still one conversation
    await send("hidden", { moderation_status: "hidden" })

    const before = await items(me)
    expect(before.data.unreadCount).toBe(2)
    expect(before.data.badgeCount).toBe(3)
    expect(before.data).not.toHaveProperty("clearKeepsRequests")

    await db.private_messages.updateMany({ where: { conversation_id: one.id, moderation_status: null }, data: { is_read: true } })
    expect((await items(me)).data.badgeCount).toBe(2)
    await db.private_messages.deleteMany({ where: { conversation_id: one.id } })
    await db.private_conversations.delete({ where: { id: one.id } })
  })
})

const notify = (userId: string, type: string, extra: Record<string, string>) =>
  sendPushNotification({ userId, title: "t", body: "b", data: { type: type as never, ...extra } })

describe("decoration is a bonus, never a reason for the bell to fail", () => {
  it("with decoration throwing, the feed is a 200 with every old field and no display, and says so in the log", async () => {
    const asker = await person("nf-fail-asker", "https://cdn.test/profile/f/1.jpg")
    const me = await person("nf-fail-me")
    const request = await db.friend_requests.create({ data: { sender_id: asker, recipient_id: me } })
    await notify(me, "friend_request", { requestId: request.id })
    const log = jest.spyOn(console, "error").mockImplementation(() => undefined)

    mockDecoration.fail = true
    const { status, data } = await items(me)
    mockDecoration.fail = false
    const withIt = await rowOf(me, "friend_request")

    expect(status).toBe(200)
    expect(data.notifications).toHaveLength(1)
    expect(data.notifications[0]).toMatchObject({ kind: "friend_request", title: "t", body: "b", readAt: null })
    expect(data.notifications[0].data).toEqual({ type: "friend_request", requestId: request.id })
    expect(data.notifications[0]).not.toHaveProperty("display")
    expect(data.notifications[0]).not.toHaveProperty("open")
    expect(data).toMatchObject({ unreadCount: 1, badgeCount: 1 })
    expect(log.mock.calls.flat().join(" ")).toContain("Failed to decorate notifications")
    log.mockRestore()
    // And the same feed, decorated, once it works again: the failure was not remembered.
    expect(withIt.open).toBe(true)
  })
})

describe("open: what is still the reader's to answer", () => {
  it("friend_request: withdrawn, or from someone since deleted, is not open and shows nothing", async () => {
    const me = await person("nf-op-me")
    const withdrawer = await person("nf-op-w", "https://cdn.test/profile/w/1.jpg")
    const gone = await person("nf-op-gone", "https://cdn.test/profile/g/1.jpg")
    const live = await person("nf-op-live")
    const rows = {
      withdrawn: await db.friend_requests.create({ data: { sender_id: withdrawer, recipient_id: me, withdrawn_at: new Date() } }),
      gone: await db.friend_requests.create({ data: { sender_id: gone, recipient_id: me } }),
      live: await db.friend_requests.create({ data: { sender_id: live, recipient_id: me } }),
    }
    await db.user.update({ where: { id: gone }, data: { deletedAt: new Date() } })
    for (const r of Object.values(rows)) await notify(me, "friend_request", { requestId: r.id })

    const byRequest = new Map((await items(me)).data.notifications.map((n) => [(n.data as { requestId: string }).requestId, n]))
    for (const key of ["withdrawn", "gone"] as const) {
      const n = byRequest.get(rows[key].id)!
      expect(n.open).toBe(false)
      expect(n).not.toHaveProperty("display")
      expect(JSON.stringify(n)).not.toContain("cdn.test")
    }
    expect(byRequest.get(rows.live.id)!.open).toBe(true)
  })

  it("message_request: open while pending, closed once answered", async () => {
    const me = await person("nf-mr-me")
    const them = await person("nf-mr-them")
    const request = await db.message_requests.create({ data: { sender_id: them, recipient_id: me, message: "hello there" } })
    await notify(me, "message_request", { requestId: request.id })
    expect((await rowOf(me, "message_request")).open).toBe(true)
    await db.message_requests.update({ where: { id: request.id }, data: { status: "accepted" } })
    expect((await rowOf(me, "message_request")).open).toBe(false)
    // Somebody else's request id is not the reader's to answer.
    const stranger = await person("nf-mr-stranger")
    await notify(stranger, "message_request", { requestId: request.id })
    expect((await rowOf(stranger, "message_request")).open).toBe(false)
  })

  it("board_request: open while pending, closed once decided or withdrawn", async () => {
    const me = await person("nf-br-me")
    const them = await person("nf-br-them")
    const eventId = await makeEvent(me)
    events.push(eventId)
    const post = await db.board_posts.create({ data: { event_id: eventId, author_id: me, kind: "seeking", body: "a plus one" } })
    const request = await db.board_requests.create({ data: { event_id: eventId, post_id: post.id, from_user_id: them, to_user_id: me } })
    await notify(me, "board_request", { eventId, requestId: request.id })
    expect((await rowOf(me, "board_request")).open).toBe(true)
    for (const status of ["accepted", "declined", "withdrawn"] as const) {
      await db.board_requests.update({ where: { id: request.id }, data: { status, decided_at: new Date() } })
      expect((await rowOf(me, "board_request")).open).toBe(false)
    }
  })

  it("crew_invite: closed when the reader has already joined, or has declined", async () => {
    const owner = await person("nf-ci-owner")
    const me = await person("nf-ci-me")
    const crew = await db.crews.create({ data: { name: "Joined", created_by: owner, emblem_seed: "seed-joined" } })
    crews.push(crew.id)
    const invite = await db.crew_invites.create({ data: { crew_id: crew.id, invited_user_id: me, invited_by: owner } })
    await notify(me, "crew_invite", { crewId: crew.id })
    expect((await rowOf(me, "crew_invite")).open).toBe(true)

    await db.crew_members.create({ data: { crew_id: crew.id, user_id: me, consented_reveal_at: new Date() } })
    const joined = await rowOf(me, "crew_invite")
    expect(joined.open).toBe(false)
    // Still the crew's emblem: closing the question does not lose the picture.
    expect(joined.display).toEqual({ visual: { type: "emblem", seed: "seed-joined" } })

    await db.crew_members.delete({ where: { crew_id_user_id: { crew_id: crew.id, user_id: me } } })
    await db.crew_invites.update({ where: { id: invite.id }, data: { removed_at: new Date() } })
    expect((await rowOf(me, "crew_invite")).open).toBe(false)
  })
})

describe("emblems and tiles for the other kinds", () => {
  it("crew_here draws the crew's emblem seed; blend draws its own id; neither carries text", async () => {
    const owner = await person("nf-em-owner")
    const me = await person("nf-em-me")
    const crew = await db.crews.create({ data: { name: "Secret Name", created_by: owner, emblem_seed: "seed-here" } })
    crews.push(crew.id)
    const blendId = randomUUID()
    await notify(me, "crew_here", { crewId: crew.id, chatGroupId: randomUUID() })
    await notify(me, "blend", { blendId, chatGroupId: randomUUID() })

    const here = await rowOf(me, "crew_here")
    const blend = await rowOf(me, "blend")
    expect(here.display).toEqual({ visual: { type: "emblem", seed: "seed-here" } })
    expect(blend.display).toEqual({ visual: { type: "emblem", seed: blendId } })
    expect(JSON.stringify([here, blend])).not.toContain("Secret Name")
    expect(here).not.toHaveProperty("open")
  })

  it("each event kind has its own badge; a deleted or unknown event has no display at all", async () => {
    const host = await person("nf-ev-host")
    const me = await person("nf-ev-me")
    const live = await makeEvent(host)
    const deleted = await makeEvent(host, { deleted_at: new Date() })
    events.push(live, deleted)

    await notify(me, "waitlist_promoted", { eventId: live })
    await notify(me, "announcement", { eventId: live })
    await notify(me, "rating_request", { eventId: live })
    await notify(me, "event_update", { eventId: deleted })
    await notify(me, "event_changed", { eventId: randomUUID() })

    const rows = (await items(me)).data.notifications
    const visualOf = (kind: string, eventId?: string) => rows.find((n) => n.kind === kind && (!eventId || (n.data as { eventId: string }).eventId === eventId))
    expect(visualOf("waitlist_promoted")!.display.visual).toMatchObject({ type: "event", badge: "star", cancelled: false })
    expect(visualOf("announcement")!.display.visual).toMatchObject({ type: "event", badge: "megaphone" })
    expect(visualOf("rating_request")!.display.visual).toMatchObject({ type: "event", badge: "star" })
    expect(visualOf("event_update", deleted)).not.toHaveProperty("display")
    expect(visualOf("event_changed")).not.toHaveProperty("display")
  })
})

describe("badgeCount does not count what is not the reader's to read", () => {
  it("not a message the reader sent, not a closed conversation, not another thread's other side", async () => {
    const me = await person("nf-bc-me")
    const a = await person("nf-bc-a")
    const b = await person("nf-bc-b")
    const c = await person("nf-bc-c")
    const thread = async (other: string, closed = false) => {
      const [user1_id, user2_id] = [me, other].sort()
      return db.private_conversations.create({ data: { user1_id, user2_id, ...(closed && { closed_at: new Date() }) } })
    }
    const mine = await thread(a) // the only unread message in it is one I sent
    const closed = await thread(b, true) // unread, but the conversation is gone for both
    const live = await thread(c) // the one that counts
    await db.private_messages.create({ data: { conversation_id: mine.id, sender_id: me, message_text: "did you get it" } })
    await db.private_messages.create({ data: { conversation_id: closed.id, sender_id: b, message_text: "hello?" } })
    await db.private_messages.create({ data: { conversation_id: live.id, sender_id: c, message_text: "hi" } })
    // A thread between two other people, with an unread message, is nobody's but theirs.
    const [u1, u2] = [a, b].sort()
    const theirs = await db.private_conversations.create({ data: { user1_id: u1, user2_id: u2 } })
    await db.private_messages.create({ data: { conversation_id: theirs.id, sender_id: a, message_text: "psst" } })

    expect((await items(me)).data.badgeCount).toBe(1)

    await db.private_messages.deleteMany({ where: { conversation_id: { in: [mine.id, closed.id, live.id, theirs.id] } } })
    await db.private_conversations.deleteMany({ where: { id: { in: [mine.id, closed.id, live.id, theirs.id] } } })
  })
})
