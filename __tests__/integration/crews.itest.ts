import { NextRequest } from "next/server"

/*
 * Crews, end to end on a migrate-deploy database (step 8: TQ-A11 CR-I03..I05,
 * CR-U01/U02 at the API; TQ-S07 CR-K01/K02 for crew rooms; TQ-X07 SEC-22).
 * Real routes, real rows, and the real socket server.
 *
 * What each block proves, and the mutation that would make it pass vacuously:
 *   - the cap holds under a race (13 accepts at once, one seat each) — μ count
 *     without the crew row lock;
 *   - only friends can be invited, and a refused invite writes nothing — μ
 *     check friendship of the creator only on create;
 *   - a name or bio with contact details is refused and never stored;
 *   - "We're here" pushes the others once, never the tapper, and checks
 *     nobody in — μ check the crew in;
 *   - presence is derived: the second check-in lists the crew, and nothing
 *     about the crew is written by it — μ a stored flag;
 *   - the crew room's door is crew membership now, over HTTP and the socket,
 *     and a removed member is taken out live — μ "has a member row".
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
process.env.NEXTAUTH_SECRET ??= "itest-crews-secret-of-32-characters-xxxxx"
process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"

import { createServer } from "http"
import type { AddressInfo } from "net"
import { io as connect, type Socket as ClientSocket } from "socket.io-client"
import { signAccessToken } from "@/lib/mobile-auth"
import { initSocketServer } from "@/lib/socket-server"
import { stopSponsoredScheduler } from "@/lib/sponsored-scheduler"
import { canJoinChat } from "@/lib/socket-auth"
import { conversationPair } from "@/lib/conversations"
import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, onboard, putInRoom, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const crewsRoute = require("@/app/api/mobile/crews/route") as typeof import("@/app/api/mobile/crews/route")
const crewRoute = require("@/app/api/mobile/crews/[crewId]/route") as typeof import("@/app/api/mobile/crews/[crewId]/route")
const invitesRoute = require("@/app/api/mobile/crews/[crewId]/invites/route") as typeof import("@/app/api/mobile/crews/[crewId]/invites/route")
const joinRoute = require("@/app/api/mobile/crews/[crewId]/join/route") as typeof import("@/app/api/mobile/crews/[crewId]/join/route")
const memberRoute = require("@/app/api/mobile/crews/[crewId]/members/[userId]/route") as typeof import("@/app/api/mobile/crews/[crewId]/members/[userId]/route")
const hereRoute = require("@/app/api/mobile/crews/[crewId]/here/route") as typeof import("@/app/api/mobile/crews/[crewId]/here/route")
const eventCrewsRoute = require("@/app/api/mobile/events/[eventId]/crews/route") as typeof import("@/app/api/mobile/events/[eventId]/crews/route")
const messagesRoute = require("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route")
const participantsRoute = require("@/app/api/mobile/chat/groups/[chatGroupId]/participants/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/participants/route")
const accountRoute = require("@/app/api/mobile/account/route") as typeof import("@/app/api/mobile/account/route")
/* eslint-enable @typescript-eslint/no-require-imports */

type Handler = (req: NextRequest, ctx: { params: Promise<never> }) => Promise<Response>
interface Person {
  id: string
  token: string
}

const users: string[] = []
const events: string[] = []

async function person(label: string, name = `Asha ${label} Rao`): Promise<Person> {
  const id = await makeUser(testId(label))
  users.push(id)
  await onboard(id)
  await db.profiles.update({ where: { id }, data: { name, age: 27 } })
  return { id, token: signAccessToken(id, `${id}@itest.invalid`) }
}

async function befriend(a: Person, ...others: Person[]) {
  await db.friendships.createMany({
    data: others.map((b) => {
      const [user1_id, user2_id] = conversationPair(a.id, b.id)
      return { user1_id, user2_id }
    }),
    skipDuplicates: true,
  })
}

async function call(
  handler: unknown,
  path: string,
  as: Person,
  opts: { method?: string; body?: unknown; params?: Record<string, string> } = {}
) {
  const res = await (handler as Handler)(
    new NextRequest(`http://localhost${path}`, {
      method: opts.method ?? "GET",
      headers: { authorization: `Bearer ${as.token}`, "content-type": "application/json" },
      ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
    }),
    { params: Promise.resolve(opts.params ?? {}) as Promise<never> }
  )
  return { status: res.status, body: await res.json() }
}

const api = {
  create: (as: Person, body: Record<string, unknown>) =>
    call(crewsRoute.POST, "/api/mobile/crews", as, { method: "POST", body: { revealConsent: true, ...body } }),
  mine: (as: Person) => call(crewsRoute.GET, "/api/mobile/crews", as),
  detail: (as: Person, crewId: string) => call(crewRoute.GET, `/api/mobile/crews/${crewId}`, as, { params: { crewId } }),
  invite: (as: Person, crewId: string, userIds: string[]) =>
    call(invitesRoute.POST, `/api/mobile/crews/${crewId}/invites`, as, { method: "POST", body: { userIds }, params: { crewId } }),
  join: (as: Person, crewId: string, body: Record<string, unknown> = { revealConsent: true }) =>
    call(joinRoute.POST, `/api/mobile/crews/${crewId}/join`, as, { method: "POST", body, params: { crewId } }),
  remove: (as: Person, crewId: string, userId: string) =>
    call(memberRoute.DELETE, `/api/mobile/crews/${crewId}/members/${userId}`, as, { method: "DELETE", params: { crewId, userId } }),
  here: (as: Person, crewId: string, eventId: string) =>
    call(hereRoute.POST, `/api/mobile/crews/${crewId}/here`, as, { method: "POST", body: { eventId }, params: { crewId } }),
  atEvent: (as: Person, eventId: string) => call(eventCrewsRoute.GET, `/api/mobile/events/${eventId}/crews`, as, { params: { eventId } }),
  read: (as: Person, g: string) => call(messagesRoute.GET, `/api/mobile/chat/groups/${g}/messages`, as, { params: { chatGroupId: g } }),
  send: (as: Person, g: string, content = `hi ${testId("m")}`) =>
    call(messagesRoute.POST, `/api/mobile/chat/groups/${g}/messages`, as, { method: "POST", body: { content }, params: { chatGroupId: g } }),
  roster: (as: Person, g: string) =>
    call(participantsRoute.GET, `/api/mobile/chat/groups/${g}/participants`, as, { params: { chatGroupId: g } }),
}

/** A crew made through the route, everyone in it a friend of the creator and joined through the route. */
async function crewOf(owner: Person, members: Person[], name = "Saturday Lot") {
  await befriend(owner, ...members)
  const made = await api.create(owner, { name, inviteUserIds: members.map((m) => m.id) })
  expect(made.status).toBe(201)
  for (const m of members) expect((await api.join(m, made.body.data.crewId)).status).toBe(200)
  return { crewId: made.body.data.crewId as string, roomId: made.body.data.chatGroupId as string }
}

async function liveEvent(host: string) {
  const eventId = await makeEvent(host)
  events.push(eventId)
  return { eventId, occurrenceId: await occurrenceOf(eventId) }
}

/* -------------------------------------------------------------------------- */
/* The real socket server                                                      */
/* -------------------------------------------------------------------------- */

const httpServer = createServer()
const io = initSocketServer(httpServer)
const clients: ClientSocket[] = []

async function online(p: Person) {
  const { port } = httpServer.address() as AddressInfo
  const socket = connect(`http://localhost:${port}`, { auth: { token: p.token }, transports: ["websocket"], reconnection: false })
  clients.push(socket)
  const heard = { message: [] as { message: { content: string; userName: string } }[], refused: [] as unknown[] }
  socket.on("chat:message", (m) => heard.message.push(m))
  socket.on("error", (e) => heard.refused.push(e))
  await new Promise<void>((resolve, reject) => {
    socket.on("connect", () => resolve())
    socket.on("connect_error", reject)
  })
  return { socket, heard, id: p.id }
}

const inRoom = async (chatGroupId: string, userId: string) =>
  (await io.in(`chat:${chatGroupId}`).fetchSockets()).some((s) => s.data.userId === userId)

async function until(check: () => boolean | Promise<boolean>, ms = 3000) {
  for (let waited = 0; waited < ms; waited += 25) {
    if (await check()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return false
}

async function joins(c: Awaited<ReturnType<typeof online>>, chatGroupId: string): Promise<boolean> {
  const before = c.heard.refused.length
  c.socket.emit("join:chat", chatGroupId)
  await until(async () => c.heard.refused.length > before || (await inRoom(chatGroupId, c.id)))
  return inRoom(chatGroupId, c.id)
}

beforeAll(async () => {
  await new Promise<void>((resolve) => httpServer.listen(0, resolve))
})

afterAll(async () => {
  for (const c of clients) c.close()
  stopSponsoredScheduler()
  globalThis.__blendnSocketIo = null
  await new Promise<void>((resolve) => io.close(() => resolve()))
  // Crew rows first: every crew foreign key is RESTRICT.
  const crews = (
    await db.crews.findMany({
      where: { OR: [{ created_by: { in: users } }, { members: { some: { user_id: { in: users } } } }] },
      select: { id: true },
    })
  ).map((c) => c.id)
  const rooms = { chat_group: { crew_id: { in: crews } } }
  await db.moderation_flags.deleteMany({ where: { user_id: { in: users } } })
  await db.chat_messages.deleteMany({ where: rooms })
  await db.chat_group_members.deleteMany({ where: rooms })
  await db.chat_groups.deleteMany({ where: { crew_id: { in: crews } } })
  await db.crew_invites.deleteMany({ where: { crew_id: { in: crews } } })
  await db.crew_members.deleteMany({ where: { crew_id: { in: crews } } })
  await db.crews.deleteMany({ where: { id: { in: crews } } })
  await db.notifications.deleteMany({ where: { user_id: { in: users } } })
  await db.blocked_users.deleteMany({ where: { OR: [{ blocker_id: { in: users } }, { blocked_id: { in: users } }] } })
  await db.friendships.deleteMany({ where: { OR: [{ user1_id: { in: users } }, { user2_id: { in: users } }] } })
  await db.presence_sessions.deleteMany({ where: { user_id: { in: users } } })
  await db.deleted_account_records.deleteMany({ where: { user_id: { in: users } } }).catch(() => undefined)
  await cleanup(users, events)
  await closeDb()
})

/* -------------------------------------------------------------------------- */

describe("the database holds the shape", () => {
  it("a crew's room has the crew as its one owner, one room per crew (chat_groups_one_owner)", async () => {
    const owner = await person("db-owner")
    const crew = await db.crews.create({ data: { name: "Shape", emblem_seed: "x", created_by: owner.id }, select: { id: true } })
    const insert = (kind: string, crewId: string | null, eventId: string | null) =>
      db.$executeRawUnsafe(
        `INSERT INTO chat_groups (id, name, kind, crew_id, event_id) VALUES (gen_random_uuid(), 'x', $1::chat_group_kind, $2::uuid, $3::uuid)`,
        kind,
        crewId,
        eventId
      )
    const { eventId } = await liveEvent(owner.id)
    const oneOwner = /23514[\s\S]*chat_groups_one_owner/
    await expect(insert("crew", null, null)).rejects.toThrow(oneOwner)
    await expect(insert("crew", crew.id, eventId)).rejects.toThrow(oneOwner)
    await expect(insert("event", eventId, null).then(() => insert("event", null, null))).rejects.toThrow(oneOwner)
    await insert("crew", crew.id, null)
    await expect(insert("crew", crew.id, null)).rejects.toThrow(/23505[\s\S]*chat_groups_crew_id_key/)
    // Nor a Blend room without its Blend (blends.itest.ts proves that arm).
    await expect(insert("blend", null, null)).rejects.toThrow(oneOwner)
  })

  it("holds the name, bio and tag limits in SQL, not only in the route", async () => {
    const owner = await person("db-limits")
    const make = (data: { name: string; bio?: string; tags?: string[] }) =>
      db.crews.create({ data: { emblem_seed: "x", created_by: owner.id, ...data } })
    await expect(make({ name: "A" })).rejects.toThrow(/crews_name_length/)
    await expect(make({ name: "x".repeat(33) })).rejects.toThrow(/crews_name_length/)
    await expect(make({ name: "Lot", bio: "x".repeat(141) })).rejects.toThrow(/crews_bio_length/)
    await expect(make({ name: "Lot", tags: ["a", "b", "c", "d"] })).rejects.toThrow(/crews_tags_max/)
    // Names are not unique.
    await make({ name: "Twice" })
    await make({ name: "Twice" })
    expect(await db.crews.count({ where: { created_by: owner.id, name: "Twice" } })).toBe(2)
  })
})

describe("made from friends, 2–12, consent on joining (CR-I03, CR-U01/U02)", () => {
  it("refuses a non-friend invitee — the same 404 whoever they are — and writes nothing", async () => {
    const owner = await person("nf-owner")
    const friend = await person("nf-friend")
    const stranger = await person("nf-stranger")
    await befriend(owner, friend)
    const before = await db.crews.count({ where: { created_by: owner.id } })
    const res = await api.create(owner, { name: "Not friends", inviteUserIds: [friend.id, stranger.id] })
    expect(res.status).toBe(404)
    expect(await db.crews.count({ where: { created_by: owner.id } })).toBe(before)
    expect(await db.crew_invites.count({ where: { invited_user_id: { in: [friend.id, stranger.id] } } })).toBe(0)
    // A nobody id answers exactly the same.
    expect((await api.create(owner, { name: "Ghost", inviteUserIds: ["no-such-user"] })).status).toBe(404)

    // Inviting later: a member can only invite their own friends.
    const { crewId } = await crewOf(owner, [friend])
    expect((await api.invite(friend, crewId, [stranger.id])).status).toBe(404)
    await befriend(friend, stranger)
    expect((await api.invite(friend, crewId, [stranger.id])).status).toBe(200)
  })

  it("refuses contact details in the name or bio, and stores neither", async () => {
    const owner = await person("cd-owner")
    for (const body of [
      { name: "Lot 98450 12345" },
      { name: "Saturday Lot", bio: "find us @thesaturdaylot" },
      { name: "Saturday Lot", bio: "priya at gmail dot com" },
      { name: "Saturday Lot", bio: "nine eight four five six seven three two" },
    ]) {
      const res = await api.create(owner, body)
      expect(res.status).toBe(400)
      expect(res.body.error).toMatch(/contact details can't go on it/)
    }
    expect(await db.crews.count({ where: { created_by: owner.id } })).toBe(0)
  })

  it("refuses a join without the reveal consent", async () => {
    const owner = await person("rc-owner")
    const friend = await person("rc-friend")
    await befriend(owner, friend)
    const made = await api.create(owner, { name: "Consent", inviteUserIds: [friend.id] })
    expect((await api.join(friend, made.body.data.crewId, { revealConsent: false })).status).toBe(400)
    expect((await api.join(friend, made.body.data.crewId, {})).status).toBe(400)
    const joined = await api.join(friend, made.body.data.crewId, { revealConsent: true, keepMeAnonymous: true })
    expect(joined.status).toBe(200)
    const row = await db.crew_members.findUniqueOrThrow({
      where: { crew_id_user_id: { crew_id: made.body.data.crewId, user_id: friend.id } },
      select: { consented_reveal_at: true, keep_me_anonymous: true },
    })
    expect(row.consented_reveal_at).toBeInstanceOf(Date)
    expect(row.keep_me_anonymous).toBe(true)
  })

  it("invites up to 12 and refuses the 13th; leaving down to one dissolves the crew and archives its chat", async () => {
    const owner = await person("cap-owner")
    const friends = await Promise.all(Array.from({ length: 12 }, (_, i) => person(`cap-${i}`)))
    await befriend(owner, ...friends)
    const { crewId, roomId } = await crewOf(owner, [friends[0]])
    expect((await api.invite(owner, crewId, friends.slice(1, 11).map((f) => f.id))).status).toBe(200)
    // 2 members + 10 open invites = 12: one more is the 13th.
    const thirteenth = await api.invite(owner, crewId, [friends[11].id])
    expect(thirteenth.status).toBe(409)
    expect(await db.crew_invites.count({ where: { crew_id: crewId, invited_user_id: friends[11].id } })).toBe(0)

    // Down to one: the owner leaves, then the last but one.
    const solo = await api.remove(friends[0], crewId, friends[0].id)
    expect(solo.body.data).toEqual({ dissolved: true })
    const crew = await db.crews.findUniqueOrThrow({ where: { id: crewId }, select: { dissolved_at: true } })
    expect(crew.dissolved_at).toBeInstanceOf(Date)
    expect(await db.crew_members.count({ where: { crew_id: crewId } })).toBe(0)
    expect(await db.crew_invites.count({ where: { crew_id: crewId } })).toBe(0)
    expect((await db.chat_groups.findUniqueOrThrow({ where: { id: roomId }, select: { status: true } })).status).toBe("archived")
    // Gone for everyone: the chat, the detail, an accept on an old invite.
    expect((await api.read(owner, roomId)).status).toBe(404)
    expect((await api.detail(owner, crewId)).status).toBe(404)
    expect((await api.join(friends[1], crewId)).status).toBe(404)
  })

  it("never seats a 13th, however many accept at once (race)", async () => {
    const owner = await person("race-owner")
    const friends = await Promise.all(Array.from({ length: 13 }, (_, i) => person(`race-${i}`)))
    await befriend(owner, ...friends)
    const made = await api.create(owner, { name: "Race" })
    const crewId = made.body.data.crewId as string
    // Thirteen open invites, written past the invite cap on purpose: the
    // accept's own count under the crew lock is what must hold.
    await db.crew_invites.createMany({ data: friends.map((f) => ({ crew_id: crewId, invited_user_id: f.id, invited_by: owner.id })) })
    const answers = await Promise.all(friends.map((f) => api.join(f, crewId)))
    const statuses = answers.map((a) => a.status).sort()
    expect(statuses.filter((s) => s === 200)).toHaveLength(11)
    expect(statuses.filter((s) => s === 409)).toHaveLength(2)
    expect(await db.crew_members.count({ where: { crew_id: crewId } })).toBe(12)
  })
})

describe("the crew room: real first names inside, its members now and nobody else (CR-K01/K02)", () => {
  it("answers members, a stranger and a removed member over HTTP and the socket, and takes the removed one out live", async () => {
    const owner = await person("door-owner", "Rohan Dsouza")
    const member = await person("door-member", "Ananya Bhat")
    const leaver = await person("door-leaver", "Kavya Nair")
    const stranger = await person("door-stranger")
    const { crewId, roomId } = await crewOf(owner, [member, leaver])

    // Members read and write; the room calls them by first name, never the full name.
    expect((await api.send(owner, roomId, "first round on me")).status).toBe(201)
    const history = await api.read(member, roomId)
    expect(history.status).toBe(200)
    const line = history.body.data.messages.find((m: { content: string }) => m.content === "first round on me")
    expect(line.user.name).toBe("Rohan")
    expect(line.user.id).not.toBe(owner.id)
    const roster = await api.roster(member, roomId)
    expect(roster.body.data.participants.map((p: { name: string }) => p.name).sort()).toEqual(["Ananya", "Kavya", "Rohan"])
    expect(JSON.stringify(roster.body)).not.toMatch(/Dsouza|Bhat|Nair/)

    // A stranger: no row, no door.
    expect((await api.read(stranger, roomId)).status).toBe(403)
    expect(await canJoinChat(stranger.id, roomId)).toBe(false)
    const strangerSocket = await online(stranger)
    expect(await joins(strangerSocket, roomId)).toBe(false)

    // The member who will be removed is in the room, live.
    const leaverSocket = await online(leaver)
    expect(await joins(leaverSocket, roomId)).toBe(true)
    // The owner removes them by the handle the crew showed — a raw id names nobody.
    expect((await api.remove(owner, crewId, leaver.id)).status).toBe(404)
    const detail = await api.detail(owner, crewId)
    const handle = detail.body.data.members.find((m: { name: string }) => m.name === "Kavya").userId
    expect(handle).toMatch(/^rh_/)
    expect((await api.remove(owner, crewId, handle)).body.data).toEqual({ dissolved: false })
    // Out of the room live, and refused on rejoin; their row stays, `left`, for the history.
    expect(await until(async () => !(await inRoom(roomId, leaver.id)))).toBe(true)
    expect(await joins(leaverSocket, roomId)).toBe(false)
    expect((await api.read(leaver, roomId)).status).toBe(403)
    expect((await api.send(leaver, roomId)).status).toBe(403)
    const row = await db.chat_group_members.findUniqueOrThrow({
      where: { chat_group_id_user_id: { chat_group_id: roomId, user_id: leaver.id } },
      select: { status: true },
    })
    expect(row.status).toBe("left")
    // The member stays; a message still reaches them and not the removed socket.
    const memberSocket = await online(member)
    expect(await joins(memberSocket, roomId)).toBe(true)
    expect((await api.send(owner, roomId, "after the removal")).status).toBe(201)
    expect(await until(() => memberSocket.heard.message.some((m) => m.message.content === "after the removal"))).toBe(true)
    expect(leaverSocket.heard.message.some((m) => m.message.content === "after the removal")).toBe(false)
    // Other people's crews are the same 404 as no crew.
    expect((await api.detail(stranger, crewId)).status).toBe(404)
  })

  it("a suspended member is on no crew surface", async () => {
    const owner = await person("susp-owner")
    const a = await person("susp-a", "Imran Qureshi")
    const b = await person("susp-b")
    const { crewId, roomId } = await crewOf(owner, [a, b])
    await db.user.update({ where: { id: a.id }, data: { suspended_at: new Date() } })
    const detail = await api.detail(owner, crewId)
    expect(detail.body.data.size).toBe(2)
    expect(JSON.stringify(detail.body)).not.toMatch(/Imran/)
    expect(await canJoinChat(a.id, roomId)).toBe(false)
    expect((await api.roster(owner, roomId)).body.data.participants).toHaveLength(2)
  })
})

describe("\"We're here\" and presence at an event (CR-I04, CR-I05)", () => {
  it("pushes every other member once — not the tapper, not someone who muted the chat — and checks nobody in", async () => {
    const owner = await person("here-owner")
    const a = await person("here-a")
    const muted = await person("here-muted")
    const { crewId, roomId } = await crewOf(owner, [a, muted])
    await db.chat_group_members.update({
      where: { chat_group_id_user_id: { chat_group_id: roomId, user_id: muted.id } },
      data: { notification_preferences: { muted: true, muted_until: null } },
    })
    const { eventId, occurrenceId } = await liveEvent(owner.id)

    // Not checked in: refused, nothing sent.
    expect((await api.here(owner, crewId, eventId)).status).toBe(403)
    await putInRoom({ eventId, occurrenceId, userId: owner.id })
    const checkInsBefore = await db.event_check_ins.count({ where: { user_id: { in: [a.id, muted.id] } } })

    const first = await api.here(owner, crewId, eventId)
    expect(first.status).toBe(200)
    expect(first.body.data).toEqual({ notified: 1, repeated: false })
    const told = await db.notifications.findMany({ where: { kind: "crew_here", user_id: { in: [owner.id, a.id, muted.id] } }, select: { user_id: true, body: true } })
    expect(told.map((t) => t.user_id)).toEqual([a.id])
    // The push names nobody and no place.
    expect(told[0].body).not.toMatch(/here-owner|Asha|Test/)
    // Nobody else was checked in by it.
    expect(await db.event_check_ins.count({ where: { user_id: { in: [a.id, muted.id] } } })).toBe(checkInsBefore)
    // The line in the crew chat, by the tapper, with the event for the crew.
    const line = await db.chat_messages.findFirstOrThrow({ where: { chat_group_id: roomId, type: "system" }, select: { user_id: true, metadata: true } })
    expect(line.user_id).toBe(owner.id)
    expect(line.metadata).toEqual({ kind: "crew_here", eventId })

    // Again: nobody is told twice.
    expect((await api.here(owner, crewId, eventId)).body.data).toEqual({ notified: 0, repeated: true })
    expect(await db.notifications.count({ where: { kind: "crew_here", user_id: a.id } })).toBe(1)
    // A crew it is not: the same 404.
    const stranger = await person("here-stranger")
    expect((await api.here(stranger, crewId, eventId)).status).toBe(404)
  })

  it("lists a crew once two of its members are checked in, and writes nothing to say so (derived)", async () => {
    const host = await person("pres-host")
    const { eventId, occurrenceId } = await liveEvent(host.id)
    const [p1, p2, p3] = await Promise.all(["p1", "p2", "p3"].map((l) => person(`pres-${l}`)))
    const [v1, v2] = await Promise.all(["v1", "v2"].map((l) => person(`pres-${l}`)))
    const them = await crewOf(p1, [p2, p3], "Two Here")
    const mine = await crewOf(v1, [v2], "Viewers")
    for (const v of [v1, v2]) await putInRoom({ eventId, occurrenceId, userId: v.id })

    // Not checked in: refused, as the roster is.
    expect((await api.atEvent(p3, eventId)).status).toBe(403)

    await putInRoom({ eventId, occurrenceId, userId: p1.id })
    await db.chat_groups.create({ data: { event_id: eventId, name: "room" } }).catch(() => undefined)
    let seen = await api.atEvent(v1, eventId)
    expect(seen.status).toBe(200)
    expect(seen.body.data.crews.map((c: { crewId: string }) => c.crewId)).not.toContain(them.crewId)
    expect(seen.body.data.myCrews).toEqual([{ crewId: mine.crewId, name: "Viewers", presentCount: 2 }])

    const stamp = await db.crews.findUniqueOrThrow({ where: { id: them.crewId }, select: { updated_at: true } })
    const rowsBefore = await Promise.all([db.crew_members.count(), db.crew_invites.count(), db.chat_group_members.count({ where: { chat_group: { crew_id: them.crewId } } })])
    await putInRoom({ eventId, occurrenceId, userId: p2.id })
    seen = await api.atEvent(v1, eventId)
    const card = seen.body.data.crews.find((c: { crewId: string }) => c.crewId === them.crewId)
    expect(card).toMatchObject({ name: "Two Here", size: 3, presentCount: 2 })
    // A card names nobody: no ids, names or photos of its members.
    expect(JSON.stringify(card)).not.toMatch(new RegExp([p1.id, p2.id, p3.id, "Asha"].join("|")))
    // Derived: the crew and its rows are exactly as they were.
    expect(await db.crews.findUniqueOrThrow({ where: { id: them.crewId }, select: { updated_at: true } })).toEqual(stamp)
    expect(
      await Promise.all([db.crew_members.count(), db.crew_invites.count(), db.chat_group_members.count({ where: { chat_group: { crew_id: them.crewId } } })])
    ).toEqual(rowsBefore)
  })

  it("a block between any member of one crew and any of the other hides them from each other", async () => {
    const host = await person("blk-host")
    const { eventId, occurrenceId } = await liveEvent(host.id)
    const [a1, a2, b1, b2] = await Promise.all(["a1", "a2", "b1", "b2"].map((l) => person(`blk-${l}`)))
    const A = await crewOf(a1, [a2], "Crew A")
    const B = await crewOf(b1, [b2], "Crew B")
    for (const p of [a1, a2, b1, b2]) await putInRoom({ eventId, occurrenceId, userId: p.id })
    const sees = async (p: Person, crewId: string) =>
      (await api.atEvent(p, eventId)).body.data.crews.some((c: { crewId: string }) => c.crewId === crewId)
    expect(await sees(a1, B.crewId)).toBe(true)
    // a2 blocks b2: neither a1 nor b1 was part of it, and still neither crew sees the other.
    await db.blocked_users.create({ data: { blocker_id: a2.id, blocked_id: b2.id } })
    expect(await sees(a1, B.crewId)).toBe(false)
    expect(await sees(b1, A.crewId)).toBe(false)
  })

  it("a person here alone sees crews only after opting in, and only crews with room for one more and of six or fewer", async () => {
    const host = await person("solo-host")
    const { eventId, occurrenceId } = await liveEvent(host.id)
    const solo = await person("solo-me")
    const small = await Promise.all(["s1", "s2"].map((l) => person(`solo-${l}`)))
    const big = await Promise.all(Array.from({ length: 7 }, (_, i) => person(`solo-big-${i}`)))
    const closed = await Promise.all(["c1", "c2"].map((l) => person(`solo-${l}`)))
    const S = await crewOf(small[0], [small[1]], "Small open")
    const L = await crewOf(big[0], big.slice(1), "Seven open")
    const C = await crewOf(closed[0], [closed[1]], "Small closed")
    await db.crews.updateMany({ where: { id: { in: [S.crewId, L.crewId] } }, data: { open_to_solo: true } })
    for (const p of [solo, ...small, big[0], big[1], ...closed]) await putInRoom({ eventId, occurrenceId, userId: p.id })

    const ids = async () => (await api.atEvent(solo, eventId)).body.data.crews.map((c: { crewId: string }) => c.crewId)
    expect(await ids()).toEqual([])
    await db.event_match_preferences.create({ data: { event_id: eventId, user_id: solo.id, open_to_crews: true } })
    expect(await ids()).toEqual([S.crewId])
    expect(C.crewId).toBeDefined()
  })

  it("is off when the host turns crews off", async () => {
    const host = await person("off-host")
    const { eventId, occurrenceId } = await liveEvent(host.id)
    await db.events.update({ where: { id: eventId }, data: { crews_enabled: false } })
    const a = await person("off-a")
    const b = await person("off-b")
    const { crewId } = await crewOf(a, [b])
    await putInRoom({ eventId, occurrenceId, userId: a.id })
    expect((await api.atEvent(a, eventId)).body.data).toEqual({ crewsEnabled: false, crews: [], myCrews: [] })
    expect((await api.here(a, crewId, eventId)).status).toBe(403)
  })
})

describe("account erasure (SEC-22)", () => {
  it("takes the person out of every crew, and a crew of two dissolves", async () => {
    const a = await person("erase-a")
    const b = await person("erase-b")
    const c = await person("erase-c")
    const pair = await crewOf(a, [b], "Pair")
    const trio = await crewOf(c, [a, b], "Trio")
    await db.profiles.update({ where: { id: a.id }, data: { onboarded: true } })
    const res = await (accountRoute.DELETE as unknown as (r: NextRequest) => Promise<Response>)(
      new NextRequest("http://localhost/api/mobile/account", { method: "DELETE", headers: { authorization: `Bearer ${a.token}` } })
    )
    expect(res.status).toBe(200)
    expect(await db.crew_members.count({ where: { user_id: a.id } })).toBe(0)
    expect((await db.crews.findUniqueOrThrow({ where: { id: pair.crewId }, select: { dissolved_at: true } })).dissolved_at).toBeInstanceOf(Date)
    expect((await db.crews.findUniqueOrThrow({ where: { id: trio.crewId }, select: { dissolved_at: true } })).dissolved_at).toBeNull()
    expect(await db.crew_members.count({ where: { crew_id: trio.crewId } })).toBe(2)
  })
})
