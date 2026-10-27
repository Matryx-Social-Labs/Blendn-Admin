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
import { conversationPair } from "@/lib/conversations"
import { notifyEventChanged, notifyEventUpdate, sendBulkPushNotifications, sendPushNotification } from "@/lib/push-notifications"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"
import { req } from "./go-live-world"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const feed = require("@/app/api/mobile/notifications/route") as typeof import("@/app/api/mobile/notifications/route")

const users: string[] = []
const events: string[] = []
const crews: string[] = []
const blendsMade: { blend: string; room: string }[] = []
const tokenOf = (id: string) => signAccessToken(id, `${id}@itest.invalid`)

async function person(label: string, photo?: string) {
  const id = await makeUser(testId(label))
  users.push(id)
  await db.profiles.upsert({ where: { id }, create: { id, name: `Person ${label}`, onboarded: true, ...(photo && { photos: [photo] }) }, update: {} })
  return id
}

/**
 * A crew `owner` runs, with an open invite from them to `invitee`, the way the app makes one: the inviter a member and
 * the invitee's friend (`inviteAcceptable`). An invite from anybody else is one the Crews screen never lists.
 */
async function crewInviting(owner: string, invitee: string, name: string, seed: string) {
  const crew = await db.crews.create({ data: { name, created_by: owner, emblem_seed: seed } })
  crews.push(crew.id)
  await db.crew_members.create({ data: { crew_id: crew.id, user_id: owner, role: "owner", consented_reveal_at: new Date() } })
  const [user1_id, user2_id] = conversationPair(owner, invitee)
  await db.friendships.create({ data: { user1_id, user2_id } })
  const invite = await db.crew_invites.create({ data: { crew_id: crew.id, invited_user_id: invitee, invited_by: owner } })
  return { crew, invite }
}

interface Row {
  id: string
  kind: string
  data: Record<string, unknown> | null
  open?: boolean
  display: { title?: string; context?: string; visual?: Record<string, unknown> }
}

/** What a build that knows `event_changed` declares on every request; an installed build declares nothing. */
const NEW_BUILD = { "x-channel-set": "2" }

const items = async (viewer: string, headers: Record<string, string> = {}) => {
  const res = await feed.GET(req("/api/mobile/notifications", tokenOf(viewer), "GET", undefined, headers))
  return { status: res.status, data: (await res.json()).data as { notifications: Row[]; unreadCount: number; badgeCount: number } }
}
const rowOf = async (viewer: string, kind: string, headers: Record<string, string> = {}) =>
  (await items(viewer, headers)).data.notifications.find((n) => n.kind === kind)!

beforeEach(() => {
  sentMessages.length = 0
  mockDecoration.fail = false
})

afterAll(async () => {
  await db.board_requests.deleteMany({ where: { event_id: { in: events } } })
  await db.board_posts.deleteMany({ where: { event_id: { in: events } } })
  await db.message_requests.deleteMany({ where: { OR: [{ sender_id: { in: users } }, { recipient_id: { in: users } }] } })
  await db.chat_group_members.deleteMany({ where: { chat_group_id: { in: blendsMade.map((b) => b.room) } } })
  await db.chat_groups.deleteMany({ where: { id: { in: blendsMade.map((b) => b.room) } } })
  await db.blends.deleteMany({ where: { id: { in: blendsMade.map((b) => b.blend) } } })
  await db.event_check_ins.deleteMany({ where: { user_id: { in: users } } })
  await db.blocked_users.deleteMany({ where: { OR: [{ blocker_id: { in: users } }, { blocked_id: { in: users } }] } })
  await db.friendships.deleteMany({ where: { OR: [{ user1_id: { in: users } }, { user2_id: { in: users } }] } })
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

describe("reveal_request rows and Clear all (SCRUM-859, SCRUM-860)", () => {
  async function askedToReveal(label: string) {
    const me = await person(`${label}-me`)
    const them = await person(`${label}-them`)
    const [user1_id, user2_id] = conversationPair(me, them)
    const mine = user1_id === me ? "user1" : "user2"
    const conv = await db.private_conversations.create({
      data: { user1_id, user2_id, user1_pseudonym: "Heron", user2_pseudonym: "Otter", [`${mine === "user1" ? "user1" : "user2"}_reveal_requested`]: false },
    })
    await sendPushNotification({ userId: me, title: "A match wants to know you", body: "b", data: { type: "reveal_request", conversationId: conv.id } })
    return { me, them, conv, mine }
  }

  it("waits on you until you have revealed, then is closed; so is one whose conversation closed", async () => {
    const w = await askedToReveal("nf-rr")
    expect((await rowOf(w.me, "reveal_request")).open).toBe(true)
    await db.private_conversations.update({ where: { id: w.conv.id }, data: { [`${w.mine}_revealed`]: true } })
    expect((await rowOf(w.me, "reveal_request")).open).toBe(false)

    const closed = await askedToReveal("nf-rrc")
    await db.private_conversations.update({ where: { id: closed.conv.id }, data: { closed_at: new Date() } })
    expect((await rowOf(closed.me, "reveal_request")).open).toBe(false)
  })

  it("Clear all keeps the requests that are open and deletes the rest, and says so", async () => {
    const w = await askedToReveal("nf-clr")
    const asker = await person("nf-clr-asker")
    const request = await db.friend_requests.create({ data: { sender_id: asker, recipient_id: w.me } })
    await sendPushNotification({ userId: w.me, title: "t", body: "b", data: { type: "friend_request", requestId: request.id } })
    await sendPushNotification({ userId: w.me, title: "t", body: "b", data: { type: "announcement", eventId: randomUUID() } })
    const answered = await askedToReveal("nf-clr2")
    await db.private_conversations.update({ where: { id: answered.conv.id }, data: { [`${answered.mine}_revealed`]: true } })
    const kinds = async (u: string) => (await db.notifications.findMany({ where: { user_id: u }, select: { kind: true } })).map((n) => n.kind).sort()

    const res = await feed.DELETE(req("/api/mobile/notifications", tokenOf(w.me), "DELETE"))
    expect((await res.json()).data).toMatchObject({ clearKeepsRequests: true })
    expect(await kinds(w.me)).toEqual(["friend_request", "reveal_request"])
    await feed.DELETE(req("/api/mobile/notifications", tokenOf(answered.me), "DELETE"))
    expect(await kinds(answered.me)).toEqual([])
    expect((await items(w.me)).data).toMatchObject({ clearKeepsRequests: true })
  })
})

describe("crew rows", () => {
  it("an invite is open until it is declined; it shows the crew's emblem and names the crew that asked (S-2)", async () => {
    const owner = await person("nf-owner")
    const me = await person("nf-invitee")
    const { crew, invite } = await crewInviting(owner, me, "Nebula", "seed-nebula")
    await sendPushNotification({ userId: me, title: "t", body: "b", data: { type: "crew_invite", crewId: crew.id } })

    const open = await rowOf(me, "crew_invite")
    expect(open.open).toBe(true)
    expect(open.display).toEqual({ context: "Nebula", visual: { type: "emblem", seed: "seed-nebula" } })

    await db.crew_invites.update({ where: { id: invite.id }, data: { declined_at: new Date() } })
    const declined = await rowOf(me, "crew_invite")
    expect(declined.open).toBe(false)
    // Declined: no longer theirs to be told the name of.
    expect(declined.display).toEqual({ visual: { type: "emblem", seed: "seed-nebula" } })
  })

  it("names the crew only while it stands and the reader is invited or in it: not once they left, nor once it is dissolved or hidden (S-2)", async () => {
    const owner = await person("nf-cs-owner")
    const left = await person("nf-cs-left")
    const invitee = await person("nf-cs-inv")
    const { crew } = await crewInviting(owner, invitee, "Old Name", "seed-cs")
    for (const id of [left, invitee]) await notify(id, "crew_invite", { crewId: crew.id })

    // A member (joining spends the invite) is told the name...
    await db.crew_members.create({ data: { crew_id: crew.id, user_id: left, consented_reveal_at: new Date() } })
    expect((await rowOf(left, "crew_invite")).display.context).toBe("Old Name")
    // ...and once they leave and the crew is renamed, neither name is theirs.
    await db.crew_members.delete({ where: { crew_id_user_id: { crew_id: crew.id, user_id: left } } })
    await db.crews.update({ where: { id: crew.id }, data: { name: "Renamed" } })
    const leftRow = await rowOf(left, "crew_invite")
    expect(leftRow.display).not.toHaveProperty("context")
    expect(JSON.stringify(leftRow)).not.toMatch(/Old Name|Renamed/)
    // The happy path: still invited.
    expect((await rowOf(invitee, "crew_invite")).display.context).toBe("Renamed")

    await db.crews.update({ where: { id: crew.id }, data: { hidden_at: new Date() } })
    expect((await rowOf(invitee, "crew_invite")).display).not.toHaveProperty("context")
    await db.crews.update({ where: { id: crew.id }, data: { hidden_at: null, dissolved_at: new Date() } })
    expect((await rowOf(invitee, "crew_invite")).display).not.toHaveProperty("context")
  })
})

describe("a crew invite is named only where the Crews screen would list it (S-2 review H1)", () => {
  const nameless = (seed: string) => ({ visual: { type: "emblem", seed } })

  it("a member who blocked the invitee, or whom the invitee blocked: not open, not named", async () => {
    for (const [label, way] of [["nf-h1-b1", "member"], ["nf-h1-b2", "invitee"]] as const) {
      const owner = await person(`${label}-owner`)
      const member = await person(`${label}-member`)
      const me = await person(`${label}-me`)
      const { crew } = await crewInviting(owner, me, "Blockers", `seed-${label}`)
      await db.crew_members.create({ data: { crew_id: crew.id, user_id: member, consented_reveal_at: new Date() } })
      await notify(me, "crew_invite", { crewId: crew.id })
      expect((await rowOf(me, "crew_invite")).display.context).toBe("Blockers")

      await db.blocked_users.create({ data: way === "member" ? { blocker_id: member, blocked_id: me } : { blocker_id: me, blocked_id: member } })
      const row = await rowOf(me, "crew_invite")
      expect([row.open, row.display]).toEqual([false, nameless(`seed-${label}`)])
      expect(JSON.stringify(row)).not.toContain("Blockers")
    }
  })

  it("an invite past its time: not open, not named", async () => {
    const owner = await person("nf-h1-exp-owner")
    const me = await person("nf-h1-exp-me")
    const { crew, invite } = await crewInviting(owner, me, "Lapsed", "seed-lapsed")
    await db.crew_invites.update({ where: { id: invite.id }, data: { created_at: new Date(Date.now() - 15 * 24 * 3_600_000) } })
    await notify(me, "crew_invite", { crewId: crew.id })
    const row = await rowOf(me, "crew_invite")
    expect([row.open, row.display]).toEqual([false, nameless("seed-lapsed")])
  })

  it("an inviter who unfriended the invitee, or left the crew: not open, not named", async () => {
    const owner = await person("nf-h1-uf-owner")
    const me = await person("nf-h1-uf-me")
    const { crew } = await crewInviting(owner, me, "Unfriended", "seed-unfriended")
    await notify(me, "crew_invite", { crewId: crew.id })
    expect((await rowOf(me, "crew_invite")).open).toBe(true)
    const [user1_id, user2_id] = conversationPair(owner, me)
    await db.friendships.deleteMany({ where: { user1_id, user2_id } })
    expect([(await rowOf(me, "crew_invite")).open, (await rowOf(me, "crew_invite")).display]).toEqual([false, nameless("seed-unfriended")])

    await db.friendships.create({ data: { user1_id, user2_id } })
    await db.crew_members.delete({ where: { crew_id_user_id: { crew_id: crew.id, user_id: owner } } })
    expect((await rowOf(me, "crew_invite")).display).toEqual(nameless("seed-unfriended"))
  })
})

describe("match rows", () => {
  it("show and name the other side by its room pseudonym, never a name or a photo (S-2)", async () => {
    const me = await person("nf-m1")
    const them = await person("nf-m2", "https://cdn.test/profile/m/2.jpg")
    const [user1_id, user2_id] = [me, them].sort()
    const convo = await db.private_conversations.create({
      data: { user1_id, user2_id, user1_pseudonym: user1_id === me ? "Quiet Otter" : "Amber Fox", user2_pseudonym: user2_id === me ? "Quiet Otter" : "Amber Fox" },
    })
    await sendPushNotification({ userId: me, title: "t", body: "b", data: { type: "match", conversationId: convo.id } })
    const row = await rowOf(me, "match")
    expect(row.display).toEqual({ context: "Amber Fox", visual: { type: "creature", pseudonym: "Amber Fox" } })
    expect(JSON.stringify(row)).not.toContain("m/2.jpg")
    expect(JSON.stringify(row)).not.toContain("Person nf-m2")
    await db.private_conversations.delete({ where: { id: convo.id } })
  })

  it("names the pseudonym only while the conversation is open and nobody blocked anybody; never the real name (S-2)", async () => {
    const me = await person("nf-mb1")
    const them = await person("nf-mb2")
    const [user1_id, user2_id] = [me, them].sort()
    const convo = await db.private_conversations.create({
      data: { user1_id, user2_id, user1_pseudonym: user1_id === me ? "Quiet Otter" : "Amber Fox", user2_pseudonym: user2_id === me ? "Quiet Otter" : "Amber Fox" },
    })
    await sendPushNotification({ userId: me, title: "t", body: "b", data: { type: "match", conversationId: convo.id } })
    // Unrevealed: the pseudonym, and the name nowhere.
    const open = await rowOf(me, "match")
    expect(open.display.context).toBe("Amber Fox")
    expect(JSON.stringify(open)).not.toContain("Person nf-mb2")

    await db.blocked_users.create({ data: { blocker_id: them, blocked_id: me } })
    expect((await rowOf(me, "match")).display).not.toHaveProperty("context")
    await db.blocked_users.deleteMany({ where: { blocker_id: them, blocked_id: me } })

    await db.private_conversations.update({ where: { id: convo.id }, data: { closed_at: new Date() } })
    expect((await rowOf(me, "match")).display).not.toHaveProperty("context")
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
    expect((await rowOf(me, "event_changed", NEW_BUILD)).data).toMatchObject({ reason: "time", changed: "venue,time" })

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
  it("is unseen bell rows plus conversations with something unread, and clearKeepsRequests is sent (SCRUM-860)", async () => {
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
    expect(before.data).toHaveProperty("clearKeepsRequests", true)

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
    const { crew, invite } = await crewInviting(owner, me, "Joined", "seed-joined")
    await notify(me, "crew_invite", { crewId: crew.id })
    expect((await rowOf(me, "crew_invite")).open).toBe(true)

    await db.crew_members.create({ data: { crew_id: crew.id, user_id: me, consented_reveal_at: new Date() } })
    const joined = await rowOf(me, "crew_invite")
    expect(joined.open).toBe(false)
    // Still the crew's emblem: closing the question does not lose the picture.
    expect(joined.display).toEqual({ context: "Joined", visual: { type: "emblem", seed: "seed-joined" } })

    await db.crew_members.delete({ where: { crew_id_user_id: { crew_id: crew.id, user_id: me } } })
    await db.crew_invites.update({ where: { id: invite.id }, data: { removed_at: new Date() } })
    const removed = await rowOf(me, "crew_invite")
    expect(removed.open).toBe(false)
    expect(removed.display).toEqual({ visual: { type: "emblem", seed: "seed-joined" } })
  })
})

describe("blend rows name the Blend through its own door (S-2)", () => {
  /** Crews A and B (in the uuid order `blends_pair_order` wants) at one event, everyone checked in, a Blend and its room. */
  async function blendOf(label: string, o: { solo?: boolean } = {}) {
    const host = await person(`${label}-host`)
    const [aMember, bMember, solo, stranger] = [await person(`${label}-a`), await person(`${label}-b`), await person(`${label}-solo`), await person(`${label}-x`)]
    const eventId = await makeEvent(host)
    events.push(eventId)
    const occurrence = await db.event_occurrences.findFirstOrThrow({ where: { event_id: eventId }, select: { id: true } })
    for (const id of [aMember, bMember, solo, stranger])
      await db.event_check_ins.create({ data: { event_id: eventId, occurrence_id: occurrence.id, user_id: id, kind: "attendee", status: "checked_in", check_in_time: new Date() } })
    const [idA, idB] = [randomUUID(), randomUUID()].sort()
    for (const [id, name, member] of [[idA, "Night Owls", aMember], [idB, "Early Birds", bMember]] as const) {
      await db.crews.create({ data: { id, name, created_by: member, emblem_seed: `seed-${id}` } })
      crews.push(id)
      await db.crew_members.create({ data: { crew_id: id, user_id: member, consented_reveal_at: new Date() } })
    }
    const name = o.solo ? "Night Owls + 1" : "Night Owls × Early Birds"
    const blend = await db.blends.create({
      data: { occurrence_id: occurrence.id, a_crew_id: idA, ...(o.solo ? { b_user_id: solo } : { b_crew_id: idB }), closes_at: new Date(Date.now() + 12 * 3_600_000) },
    })
    const room = await db.chat_groups.create({
      data: { kind: "blend", blend_id: blend.id, name, members: { createMany: { data: [aMember, o.solo ? solo : bMember].map((user_id) => ({ user_id })) } } },
    })
    blendsMade.push({ blend: blend.id, room: room.id })
    for (const id of [aMember, bMember, solo, stranger]) await notify(id, "blend", { blendId: blend.id, chatGroupId: room.id })
    return { aMember, bMember, solo, stranger, blendId: blend.id, idA, idB }
  }
  const contextOf = async (id: string) => (await rowOf(id, "blend")).display?.context

  it("both sides are told the room's name; a stranger handed the ids is told nothing", async () => {
    const b = await blendOf("nf-bl")
    expect(await contextOf(b.aMember)).toBe("Night Owls × Early Birds")
    expect(await contextOf(b.bMember)).toBe("Night Owls × Early Birds")
    const stranger = await rowOf(b.stranger, "blend")
    // No invented emblem (SCRUM-861): the app draws the Blend's glyph, and a stranger gets nothing.
    expect(stranger).not.toHaveProperty("display")
    expect((await rowOf(b.aMember, "blend")).display).toEqual({ context: "Night Owls × Early Birds" })
    expect(JSON.stringify(stranger)).not.toMatch(/Night Owls|Early Birds/)
  })

  it("the solo person is told it too; the room's '+ 1' is all anybody is told of them", async () => {
    const b = await blendOf("nf-bls", { solo: true })
    expect(await contextOf(b.solo)).toBe("Night Owls + 1")
    expect(await contextOf(b.aMember)).toBe("Night Owls + 1")
    expect(JSON.stringify(await rowOf(b.aMember, "blend"))).not.toContain("Person nf-bls-solo")
  })

  it("a block across the sides names nothing to that pair", async () => {
    const b = await blendOf("nf-blb")
    await db.blocked_users.create({ data: { blocker_id: b.bMember, blocked_id: b.aMember } })
    expect(await contextOf(b.aMember)).toBeUndefined()
    expect(await contextOf(b.bMember)).toBeUndefined()
  })

  it("a closed Blend, one past its clock, and one with a dissolved crew name nothing", async () => {
    const closed = await blendOf("nf-blc")
    await db.blends.update({ where: { id: closed.blendId }, data: { closed_at: new Date() } })
    expect(await contextOf(closed.aMember)).toBeUndefined()

    const expired = await blendOf("nf-ble")
    await db.blends.update({ where: { id: expired.blendId }, data: { closes_at: new Date(Date.now() - 1000) } })
    expect(await contextOf(expired.aMember)).toBeUndefined()

    const dissolved = await blendOf("nf-bld")
    await db.crews.update({ where: { id: dissolved.idB }, data: { dissolved_at: new Date() } })
    expect(await contextOf(dissolved.aMember)).toBeUndefined()
  })
})

describe("emblems and tiles for the other kinds", () => {
  it("crew_here draws the crew's emblem seed; blend draws its own id; a Blend the reader is not in names nothing", async () => {
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
    // A Blend carries no visual (SCRUM-861): the app draws its glyph.
    expect(blend).not.toHaveProperty("display")
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

    const rows = (await items(me, NEW_BUILD)).data.notifications
    const visualOf = (kind: string, eventId?: string) => rows.find((n) => n.kind === kind && (!eventId || (n.data as { eventId: string }).eventId === eventId))
    expect(visualOf("waitlist_promoted")!.display.visual).toMatchObject({ type: "event", badge: "star", cancelled: false })
    expect(visualOf("announcement")!.display.visual).toMatchObject({ type: "event", badge: "megaphone" })
    expect(visualOf("rating_request")!.display.visual).toMatchObject({ type: "event", badge: "star" })
    expect(visualOf("event_update", deleted)).not.toHaveProperty("display")
    expect(visualOf("event_changed")).not.toHaveProperty("display")
  })
})

describe("an event_changed row, for a build that does not know the kind (SCRUM-739)", () => {
  async function goerTold(label: string) {
    const host = await person(`${label}-host`)
    const me = await person(`${label}-me`)
    const eventId = await makeEvent(host)
    events.push(eventId)
    await notifyEventChanged([me], "Night", "Event updated: venue, start time", eventId, "venue,time")
    return { me, eventId }
  }

  it("a build that declares nothing gets the row as event_update, the shape the push downgrade sends, so a tap opens the event", async () => {
    const { me, eventId } = await goerTold("nf-old")
    const { data } = await items(me)
    expect(data.notifications).toHaveLength(1)
    expect(data.notifications[0]).toMatchObject({ kind: "event_update", title: "Night", body: "Event updated: venue, start time", readAt: null })
    expect(data.notifications[0].data).toEqual({ type: "event_update", eventId, reason: "time", changed: "venue,time" })
    // Same tile as the new kind has; the reader loses nothing but the kind's name.
    expect(data.notifications[0].display.visual).toMatchObject({ type: "event", badge: "clock" })
    expect(data.unreadCount).toBe(1)
  })

  it("a channel set before Flow 9, or one that is not a number, is an old build too", async () => {
    const { me } = await goerTold("nf-old2")
    for (const declared of ["1", "0", "-3", "two", "", "2.5"]) {
      expect((await rowOf(me, "event_update", { "x-channel-set": declared })).data).toMatchObject({ type: "event_update" })
    }
  })

  it("a build that declares channelSet 2 or later gets event_changed, untouched; the stored row is never rewritten", async () => {
    const { me, eventId } = await goerTold("nf-new")
    for (const declared of ["2", "3"]) {
      const row = await rowOf(me, "event_changed", { "x-channel-set": declared })
      expect(row.data).toEqual({ type: "event_changed", eventId, reason: "time", changed: "venue,time" })
    }
    expect((await db.notifications.findFirstOrThrow({ where: { user_id: me } })).kind).toBe("event_changed")
  })

  it("only that kind is touched: every other kind reads the same with or without the declaration", async () => {
    const me = await person("nf-same")
    const eventId = randomUUID()
    await notify(me, "event_update", { eventId })
    await notify(me, "announcement", { eventId })
    await notify(me, "report_actioned", {})
    const strip = (r: Row[]) => r.map(({ id, kind, data }) => ({ id, kind, data }))
    expect(strip((await items(me)).data.notifications)).toEqual(strip((await items(me, NEW_BUILD)).data.notifications))
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
