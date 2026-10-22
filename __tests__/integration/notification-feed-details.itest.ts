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
})

afterAll(async () => {
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
