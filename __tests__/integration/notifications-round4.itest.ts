/**
 * Backend round 4 (SCRUM-1091): the bell counts only what the bell answers, and the icon adds the talk-asks waiting
 * (requests placement A); asks named the way the approved board draws them (Flow 9 A); a crew invite always has its
 * row; an event change says what it was and is. Real handlers, real rows.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"

type Msg = { to: string; badge?: number; data: Record<string, string> }
const mockSent: Msg[] = []
jest.mock("expo-server-sdk", () => ({
  Expo: class {
    static isExpoPushToken() {
      return true
    }
    chunkPushNotifications(m: unknown[]) {
      return [m]
    }
    async sendPushNotificationsAsync(chunk: Msg[]) {
      mockSent.push(...chunk)
      return chunk.map(() => ({ status: "ok", id: "t" }))
    }
  },
}))

import { signAccessToken } from "@/lib/mobile-auth"
import { conversationPair } from "@/lib/conversations"
import { sendPushNotification } from "@/lib/push-notifications"
import { inviteToCrew } from "@/lib/crews/crews"
import { notifyEventDetailsChanged } from "@/lib/services/event-notifications.service"
import { cleanup, closeDb, db, makeEvent, makeUser, testId } from "./helpers"
import { req } from "./go-live-world"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const feed = require("@/app/api/mobile/notifications/route") as typeof import("@/app/api/mobile/notifications/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const readRoute = require("@/app/api/mobile/notifications/read/route") as typeof import("@/app/api/mobile/notifications/read/route")

const users: string[] = []
const events: string[] = []
const crews: string[] = []
const tokenOf = (id: string) => signAccessToken(id, `${id}@itest.invalid`)

async function person(label: string, o: { name?: string; photo?: string; device?: boolean } = {}) {
  const id = await makeUser(testId(label))
  users.push(id)
  const name = o.name ?? `Person ${label}`
  await db.user.update({ where: { id }, data: { name, image: o.photo ?? null } })
  await db.profiles.upsert({ where: { id }, create: { id, name, onboarded: true, ...(o.photo && { photos: [o.photo] }) }, update: { name } })
  if (o.device !== false) await db.push_tokens.create({ data: { user_id: id, token: `ExponentPushToken[${id}]`, platform: "ios" } })
  return id
}

interface Row {
  id: string
  kind: string
  title: string
  body: string
  data: Record<string, unknown> | null
  open?: boolean
  display?: { title?: string; context?: string; visual?: Record<string, unknown> }
}
type Feed = { notifications: Row[]; unreadCount: number; badgeCount: number; talkAsks: { messageRequests: number; lobbyAsks: number } }

const feedOf = async (viewer: string) => {
  const res = await feed.GET(req("/api/mobile/notifications", tokenOf(viewer)))
  expect(res.status).toBe(200)
  return (await res.json()).data as Feed
}
const badgeOf = (id: string) => mockSent.filter((m) => m.to === `ExponentPushToken[${id}]`).at(-1)?.badge

/** A pending message request from `from` to `to`, with its bell row, the way `POST /message-requests` writes them. */
async function messageRequest(from: string, to: string) {
  const r = await db.message_requests.create({ data: { sender_id: from, recipient_id: to, message: "hi", status: "pending" } })
  await sendPushNotification({ userId: to, title: "New message request", body: "x wants to connect", data: { type: "message_request", requestId: r.id } })
  return r
}

/** A live Lobby ask from `from` on `to`'s post, with its bell row. */
async function lobbyAsk(from: string, to: string, eventId: string) {
  const post = await db.board_posts.create({ data: { event_id: eventId, author_id: to, kind: "seeking", body: "a plus one" } })
  const r = await db.board_requests.create({ data: { event_id: eventId, post_id: post.id, from_user_id: from, to_user_id: to } })
  await sendPushNotification({ userId: to, title: "Someone asked", body: "b", data: { type: "board_request", requestId: r.id, eventId } })
  return r
}

beforeEach(() => {
  mockSent.length = 0
})

afterAll(async () => {
  await db.board_requests.deleteMany({ where: { event_id: { in: events } } })
  await db.board_posts.deleteMany({ where: { event_id: { in: events } } })
  await db.event_rsvps.deleteMany({ where: { event_id: { in: events } } })
  await db.message_requests.deleteMany({ where: { OR: [{ sender_id: { in: users } }, { recipient_id: { in: users } }] } })
  await db.blocked_users.deleteMany({ where: { OR: [{ blocker_id: { in: users } }, { blocked_id: { in: users } }] } })
  await db.friendships.deleteMany({ where: { OR: [{ user1_id: { in: users } }, { user2_id: { in: users } }] } })
  await db.crew_invites.deleteMany({ where: { crew_id: { in: crews } } })
  await db.crew_members.deleteMany({ where: { crew_id: { in: crews } } })
  await db.crews.deleteMany({ where: { id: { in: crews } } })
  await db.friend_requests.deleteMany({ where: { OR: [{ sender_id: { in: users } }, { recipient_id: { in: users } }] } })
  await db.notifications.deleteMany({ where: { user_id: { in: users } } })
  await db.push_tokens.deleteMany({ where: { user_id: { in: users } } })
  await cleanup(users, events)
  await closeDb()
}, 120_000)

describe("the badge split (requests placement A)", () => {
  it("the bell leaves out talk-asks; the icon counts the waiting message requests and Lobby asks; a push says the same", async () => {
    const me = await person("bs-me")
    const a = await person("bs-a", { device: false })
    const b = await person("bs-b", { device: false })
    const eventId = await makeEvent(a)
    events.push(eventId)

    await messageRequest(a, me)
    await lobbyAsk(b, me, eventId)
    // A reveal ask: a talk-ask too, so a bell row the bell does not count. Nothing for the icon (its chip is on the DM).
    await sendPushNotification({ userId: me, title: "t", body: "b", data: { type: "reveal_request", conversationId: "00000000-0000-4000-8000-000000000001" } })
    // One row the bell does count.
    await sendPushNotification({ userId: me, title: "t", body: "b", data: { type: "announcement", eventId } })

    const f = await feedOf(me)
    // All four rows are still in the feed: a talk-ask is a plain history line there.
    expect(f.notifications.map((n) => n.kind).sort()).toEqual(["announcement", "board_request", "message_request", "reveal_request"])
    expect(f.unreadCount).toBe(1)
    expect(f.talkAsks).toEqual({ messageRequests: 1, lobbyAsks: 1 })
    expect(f.badgeCount).toBe(3)
    expect(badgeOf(me)).toBe(3)
  })

  it("an answered message request, a lapsed, silenced or blocked Lobby ask is waiting on nobody", async () => {
    const me = await person("bs2-me")
    const [a, b, c, d] = await Promise.all(["bs2-a", "bs2-b", "bs2-c", "bs2-d"].map((l) => person(l, { device: false })))
    const live = await makeEvent(a)
    const ended = await makeEvent(a)
    events.push(live, ended)
    await db.events.update({ where: { id: ended }, data: { start_time: new Date(Date.now() - 3 * 3600_000), end_time: new Date(Date.now() - 3600_000) } })

    const answered = await messageRequest(a, me)
    await db.message_requests.update({ where: { id: answered.id }, data: { status: "accepted" } })
    await lobbyAsk(b, me, ended)
    const silenced = await lobbyAsk(c, me, live)
    await db.board_requests.update({ where: { id: silenced.id }, data: { silenced_at: new Date() } })
    await lobbyAsk(d, me, live)
    await db.blocked_users.create({ data: { blocker_id: me, blocked_id: d } })

    const f = await feedOf(me)
    expect(f.talkAsks).toEqual({ messageRequests: 0, lobbyAsks: 0 })
    expect(f.unreadCount).toBe(0)
    expect(f.badgeCount).toBe(0)

    // Negative control: the same person's live, unblocked ask counts.
    await lobbyAsk(a, me, live)
    expect((await feedOf(me)).talkAsks.lobbyAsks).toBe(1)
  })

  it("marking read answers the bell's own count, talk-asks left out", async () => {
    const me = await person("bs3-me")
    const a = await person("bs3-a", { device: false })
    await messageRequest(a, me)
    await sendPushNotification({ userId: me, title: "t", body: "b", data: { type: "friend_accepted" } })
    await sendPushNotification({ userId: me, title: "t", body: "b", data: { type: "friend_accepted" } })
    const one = await db.notifications.findFirstOrThrow({ where: { user_id: me, kind: "friend_accepted" }, select: { id: true } })
    const res = await readRoute.POST(req("/api/mobile/notifications/read", tokenOf(me), "POST", { ids: [one.id] }))
    expect((await res.json()).data.unreadCount).toBe(1)
  })
})

describe("named asks (Flow 9 A)", () => {
  it("a message request names its sender in full while it waits, with their initial when they have no photo", async () => {
    const me = await person("na-me")
    const sender = await person("na-s", { name: "Venkata Subramanian Raghunathan Krishnamurthy", device: false })
    const r = await messageRequest(sender, me)
    const row = (await feedOf(me)).notifications.find((n) => n.kind === "message_request")!
    expect(row.open).toBe(true)
    expect(row.display?.title).toBe("Venkata Subramanian Raghunathan Krishnamurthy wants to message you")
    expect(row.display?.visual).toEqual({ type: "initial", name: "Venkata Subramanian Raghunathan Krishnamurthy" })

    // Answered: nothing to answer, and the row no longer names anybody.
    await db.message_requests.update({ where: { id: r.id }, data: { status: "declined" } })
    const after = (await feedOf(me)).notifications.find((n) => n.kind === "message_request")!
    expect(after.open).toBe(false)
    expect(after.display?.title).toBeUndefined()
  })

  it("a message request from somebody with a photo shows it", async () => {
    const me = await person("na2-me")
    const sender = await person("na2-s", { name: "प्रियंका शर्मा", photo: "https://cdn.example/p.jpg", device: false })
    await messageRequest(sender, me)
    const row = (await feedOf(me)).notifications.find((n) => n.kind === "message_request")!
    expect(row.display?.title).toBe("प्रियंका शर्मा wants to message you")
    expect(row.display?.visual).toMatchObject({ type: "photo" })
  })

  it("a friend request names the asker in full, with their initial when they have no photo", async () => {
    const me = await person("nf-me")
    const asker = await person("nf-a", { name: "Marc-André Lefebvre-Desrosiers", device: false })
    const fr = await db.friend_requests.create({ data: { sender_id: asker, recipient_id: me } })
    await sendPushNotification({ userId: me, title: "t", body: "b", data: { type: "friend_request", requestId: fr.id } })
    const row = (await feedOf(me)).notifications.find((n) => n.kind === "friend_request")!
    expect(row.display?.title).toBe("Marc-André Lefebvre-Desrosiers wants to be friends")
    expect(row.display?.visual).toEqual({ type: "initial", name: "Marc-André Lefebvre-Desrosiers" })
  })

  it("a crew invite says the crew while the Crews screen would list it", async () => {
    const me = await person("nc-me")
    const owner = await person("nc-o", { device: false })
    const crew = await db.crews.create({ data: { name: "Thiruvananthapuram Night Owls", created_by: owner, emblem_seed: "s1" } })
    crews.push(crew.id)
    await db.crew_members.create({ data: { crew_id: crew.id, user_id: owner, role: "owner", consented_reveal_at: new Date() } })
    const [user1_id, user2_id] = conversationPair(owner, me)
    await db.friendships.create({ data: { user1_id, user2_id } })
    await db.crew_invites.create({ data: { crew_id: crew.id, invited_user_id: me, invited_by: owner } })
    await sendPushNotification({ userId: me, title: "t", body: "b", data: { type: "crew_invite", crewId: crew.id } })
    const row = (await feedOf(me)).notifications.find((n) => n.kind === "crew_invite")!
    expect(row.display?.title).toBe("Crew invite: Thiruvananthapuram Night Owls")

    // Hidden: neither named nor titled.
    await db.crews.update({ where: { id: crew.id }, data: { hidden_at: new Date() } })
    const hidden = (await feedOf(me)).notifications.find((n) => n.kind === "crew_invite")!
    expect(hidden.display?.title).toBeUndefined()
  })

  it("a crew arrival row says who: someone from the crew is here, for a member only", async () => {
    const me = await person("nh-me")
    const owner = await person("nh-o", { device: false })
    const crew = await db.crews.create({ data: { name: "Saint-Jean-sur-Richelieu Riso", created_by: owner, emblem_seed: "s2" } })
    crews.push(crew.id)
    await db.crew_members.create({ data: { crew_id: crew.id, user_id: me, role: "member", consented_reveal_at: new Date() } })
    await sendPushNotification({ userId: me, title: crew.name, body: "Priya is in.", data: { type: "crew_here", crewId: crew.id } })
    const row = (await feedOf(me)).notifications.find((n) => n.kind === "crew_here")!
    expect(row.display?.title).toBe("Someone from Saint-Jean-sur-Richelieu Riso is here")

    // More than one in: the count, as the approved Flow 9 board draws it.
    await sendPushNotification({ userId: me, title: crew.name, body: "Priya and Arjun are in.", data: { type: "crew_here", crewId: crew.id, count: "2" } })
    const two = (await feedOf(me)).notifications.find((n) => n.kind === "crew_here" && n.body.startsWith("Priya and"))!
    expect(two.display?.title).toBe("2 from Saint-Jean-sur-Richelieu Riso are here")

    // A plan is not an arrival (SCRUM-1098): its row keeps the stored words, with the crew's emblem.
    await sendPushNotification({
      userId: me,
      title: crew.name,
      body: "Arjun wants to go together. Open the crew to see the night.",
      data: { type: "crew_here", kind: "crew_plan", crewId: crew.id },
    })
    const planned = (await feedOf(me)).notifications.find((n) => n.kind === "crew_here" && n.body.startsWith("Arjun wants"))!
    expect(planned.display?.title).toBeUndefined()
    expect(planned.display?.visual).toEqual({ type: "emblem", seed: "s2" })

    // Left the crew: the row keeps its stored words and says nothing more.
    await db.crew_members.deleteMany({ where: { crew_id: crew.id, user_id: me } })
    for (const n of (await feedOf(me)).notifications.filter((n) => n.kind === "crew_here")) expect(n.display?.title).toBeUndefined()
  })
})

describe("crew invites always reach the bell", () => {
  it("a second invite from the same inviter writes its row, though only the first rings", async () => {
    const owner = await person("ci-o", { device: false })
    const me = await person("ci-me")
    const [user1_id, user2_id] = conversationPair(owner, me)
    await db.friendships.create({ data: { user1_id, user2_id } })
    const make = async (name: string) => {
      const crew = await db.crews.create({ data: { name, created_by: owner, emblem_seed: name } })
      crews.push(crew.id)
      await db.crew_members.create({ data: { crew_id: crew.id, user_id: owner, role: "owner", consented_reveal_at: new Date() } })
      return crew.id
    }
    const first = await make("Riso Owls")
    const second = await make("Riso Larks")
    expect(await inviteToCrew(owner, first, [me])).not.toHaveProperty("refusal")
    expect(await inviteToCrew(owner, second, [me])).not.toHaveProperty("refusal")
    // The pushes are fire-and-forget: wait for the rows.
    for (let i = 0; i < 50 && (await db.notifications.count({ where: { user_id: me, kind: "crew_invite" } })) < 2; i++) await new Promise((r) => setTimeout(r, 50))

    const rows = await db.notifications.findMany({ where: { user_id: me, kind: "crew_invite" }, select: { data: true } })
    expect(rows.map((r) => (r.data as { crewId: string }).crewId).sort()).toEqual([first, second].sort())
    // Only one push rang: the window spares the second one's push, never its row.
    expect(mockSent.filter((m) => m.to === `ExponentPushToken[${me}]`)).toHaveLength(1)
    const waiting = (await feedOf(me)).notifications.filter((n) => n.kind === "crew_invite" && n.open)
    expect(waiting).toHaveLength(2)
  })
})

describe("an event change says what it was and is (Flow 9 A)", () => {
  it("a moved time carries the field, both instants and the event's zone; a moved venue its two names", async () => {
    const host = await person("ec-h", { device: false })
    const me = await person("ec-me")
    const eventId = await makeEvent(host)
    events.push(eventId)
    await db.event_rsvps.create({ data: { event_id: eventId, user_id: me, status: "going" } })
    const from = new Date("2026-12-01T14:30:00Z")
    const to = new Date("2026-12-01T16:00:00Z")

    await notifyEventDetailsChanged(eventId, "Kerala night", ["start time"], { field: "time", from: from.toISOString(), to: to.toISOString(), timeZone: "Asia/Kolkata" })
    await notifyEventDetailsChanged(eventId, "Kerala night", ["venue"], { field: "venue", from: "Old Hall", to: "Saint-Jean-sur-Richelieu Hall" })

    const rows = await db.notifications.findMany({ where: { user_id: me, kind: "event_changed" }, orderBy: { created_at: "asc" }, select: { data: true } })
    expect(rows.map((r) => r.data)).toEqual([
      expect.objectContaining({ field: "time", from: from.toISOString(), to: to.toISOString(), timeZone: "Asia/Kolkata", changed: "time" }),
      expect.objectContaining({ field: "venue", from: "Old Hall", to: "Saint-Jean-sur-Richelieu Hall", changed: "venue" }),
    ])
    expect(mockSent.filter((m) => m.to === `ExponentPushToken[${me}]`).map((m) => m.data.field)).toEqual(["time", "venue"])
  })
})

describe("a city's WhatsApp Channel (Flow 9 A, ruling 7)", () => {
  it("the database takes only an https whatsapp.com channel link, and null", async () => {
    const city = await db.cities.findFirstOrThrow({ select: { id: true, whatsapp_channel_url: true } })
    const set = (url: string | null) => db.cities.update({ where: { id: city.id }, data: { whatsapp_channel_url: url } })
    try {
      await expect(set("https://whatsapp.com/channel/0029VaBlendnBLR01")).resolves.toBeTruthy()
      await expect(set(null)).resolves.toBeTruthy()
      for (const bad of ["http://whatsapp.com/channel/0029VaBlendnBLR01", "https://evil.example/channel/0029VaBlendnBLR01", "javascript:alert(1)", "https://whatsapp.com/channel/"]) {
        await expect(set(bad)).rejects.toThrow(/cities_whatsapp_channel_url_shape/)
      }
    } finally {
      await set(city.whatsapp_channel_url)
    }
  })
})
