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
let session: { user: { id: string; role: "app_admin" } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: () => Promise.resolve(session) }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
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
import { crewsToRepair, repairCrews, settleCrew } from "@/lib/crews/sweep"
import { applySuspension, liftSuspension } from "@/lib/suspension"
import { resolveReport } from "@/app/dashboard/moderation/reports/actions"
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
const reportRoute = require("@/app/api/mobile/crews/[crewId]/report/route") as typeof import("@/app/api/mobile/crews/[crewId]/report/route")
const blockRoute = require("@/app/api/mobile/users/[userId]/block/route") as typeof import("@/app/api/mobile/users/[userId]/block/route")
const friendRoute = require("@/app/api/mobile/friends/[userId]/route") as typeof import("@/app/api/mobile/friends/[userId]/route")
const conversationRoute = require("@/app/api/mobile/conversations/[conversationId]/route") as typeof import("@/app/api/mobile/conversations/[conversationId]/route")
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
  atEvent: (as: Person, eventId: string, query = "") =>
    call(eventCrewsRoute.GET, `/api/mobile/events/${eventId}/crews${query}`, as, { params: { eventId } }),
  decline: (as: Person, crewId: string) =>
    call(joinRoute.DELETE, `/api/mobile/crews/${crewId}/join`, as, { method: "DELETE", params: { crewId } }),
  report: (as: Person, crewId: string, body: Record<string, unknown> = { reason: "contact_details" }) =>
    call(reportRoute.POST, `/api/mobile/crews/${crewId}/report`, as, { method: "POST", body, params: { crewId } }),
  block: (as: Person, userId: string) =>
    call(blockRoute.POST, `/api/mobile/users/${userId}/block`, as, { method: "POST", params: { userId } }),
  unmatch: (as: Person, conversationId: string) =>
    call(conversationRoute.DELETE, `/api/mobile/conversations/${conversationId}`, as, { method: "DELETE", params: { conversationId } }),
  unfriend: (as: Person, userId: string) =>
    call(friendRoute.DELETE, `/api/mobile/friends/${userId}`, as, { method: "DELETE", params: { userId } }),
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
  await db.audit_logs.deleteMany({ where: { user_id: { in: users } } })
  await db.message_reports.deleteMany({ where: { reporter_id: { in: users } } })
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

  it("a ban in the crew room survives leaving and coming back", async () => {
    const owner = await person("ban-owner")
    const banned = await person("ban-member")
    const third = await person("ban-third")
    const { crewId, roomId } = await crewOf(owner, [banned, third])
    // A suspension writes a ban into every room the person is in.
    await db.chat_group_members.update({
      where: { chat_group_id_user_id: { chat_group_id: roomId, user_id: banned.id } },
      data: { status: "banned", banned_at: new Date() },
    })
    expect((await api.remove(banned, crewId, banned.id)).status).toBe(200)
    expect((await api.invite(owner, crewId, [banned.id])).status).toBe(200)
    expect((await api.join(banned, crewId)).status).toBe(200)
    const row = await db.chat_group_members.findUniqueOrThrow({
      where: { chat_group_id_user_id: { chat_group_id: roomId, user_id: banned.id } },
      select: { status: true },
    })
    expect(row.status).toBe("banned")
    expect(await canJoinChat(banned.id, roomId)).toBe(false)
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
    expect(line.metadata).toEqual({ kind: "crew_here", eventId, occurrenceId })

    // Again — and again with the crew's id in capitals, which is the same
    // crew: nobody is told twice, and no second line is written.
    expect((await api.here(owner, crewId, eventId)).body.data).toEqual({ notified: 0, repeated: true })
    expect((await api.here(owner, crewId.toUpperCase(), eventId)).body.data).toEqual({ notified: 0, repeated: true })
    expect(await db.notifications.count({ where: { kind: "crew_here", user_id: a.id } })).toBe(1)
    expect(await db.chat_messages.count({ where: { chat_group_id: roomId, type: "system" } })).toBe(1)
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
    // Counts, never people (C4): no ids, names, photos or pseudonyms — the
    // card's keys are exactly these. `overlaps` and `badges` (step 10) are
    // crew-held lines and crew nights, never a member (crew-signals.itest.ts).
    expect(Object.keys(card).sort()).toEqual([
      "badges", "bio", "crewId", "emblemSeed", "intent", "name", "overlaps", "presentCount", "size", "tags", "youLiked",
    ])
    expect(JSON.stringify(card)).not.toMatch(new RegExp([p1.id, p2.id, p3.id, "Asha"].join("|")))
    expect(seen.body.data).toMatchObject({ total: 1, hasMore: false })
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
    // An opt-in from a night that is over says nothing about tonight.
    await db.event_match_preferences.create({
      data: { event_id: eventId, user_id: solo.id, open_to_crews_until: new Date(Date.now() - 60_000) },
    })
    expect(await ids()).toEqual([])
    await db.event_match_preferences.update({
      where: { event_id_user_id: { event_id: eventId, user_id: solo.id } },
      data: { open_to_crews_until: new Date(Date.now() + 60 * 60 * 1000) },
    })
    // Only S: C has no room for one more, and L is seven.
    expect(await ids()).toEqual([S.crewId])

    // Seven with one of them suspended is six active, and a crew of six may meet one person.
    await db.user.update({ where: { id: big[6].id }, data: { suspended_at: new Date() } })
    const seen = await api.atEvent(solo, eventId)
    expect(seen.body.data.crews.map((c: { crewId: string }) => c.crewId).sort()).toEqual([S.crewId, L.crewId].sort())
    expect(seen.body.data.crews.find((c: { crewId: string }) => c.crewId === L.crewId).size).toBe(6)
    expect(seen.body.data.crews.map((c: { crewId: string }) => c.crewId)).not.toContain(C.crewId)
  })

  it("is off when the host turns crews off", async () => {
    const host = await person("off-host")
    const { eventId, occurrenceId } = await liveEvent(host.id)
    await db.events.update({ where: { id: eventId }, data: { crews_enabled: false } })
    const a = await person("off-a")
    const b = await person("off-b")
    const { crewId } = await crewOf(a, [b])
    await putInRoom({ eventId, occurrenceId, userId: a.id })
    expect((await api.atEvent(a, eventId)).body.data).toEqual({ crewsEnabled: false, crews: [], myCrews: [], total: 0, hasMore: false })
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

/* -------------------------------------------------------------------------- */
/* Review round (PR #630): C4–C12 and the MUSTs                                */
/* -------------------------------------------------------------------------- */

/** The invite bell lines a person has, once any push still in flight has written its own (they are not awaited). */
async function crewInvitePushes(userId: string) {
  await new Promise((r) => setTimeout(r, 300))
  return db.notifications.count({ where: { kind: "crew_invite", user_id: userId } })
}
const inviteRow = (crewId: string, userId: string) =>
  db.crew_invites.findUnique({ where: { crew_id_invited_user_id: { crew_id: crewId, invited_user_id: userId } } })
const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000)

describe("\"We're here\" once per person per crew per occurrence, kept in the database", () => {
  it("tells the crew again on the next night, from a second member, and in a second crew — and a muted phone still gets the bell", async () => {
    const owner = await person("here2-owner")
    const a = await person("here2-a")
    const quiet = await person("here2-quiet")
    const other = await person("here2-other")
    const { crewId, roomId } = await crewOf(owner, [a, quiet])
    const second = await crewOf(owner, [other], "Second Lot")
    // Notifications off: no push, but the bell line is written, as every bulk send does.
    await db.profiles.update({ where: { id: quiet.id }, data: { push_enabled: false } })
    const { eventId, occurrenceId } = await liveEvent(owner.id)
    for (const p of [owner, a]) await putInRoom({ eventId, occurrenceId, userId: p.id })

    expect((await api.here(owner, crewId, eventId)).body.data).toEqual({ notified: 2, repeated: false })
    expect(await db.notifications.count({ where: { kind: "crew_here", user_id: quiet.id } })).toBe(1)
    // A second member's own "We're here" is theirs, once.
    expect((await api.here(a, crewId, eventId)).body.data).toEqual({ notified: 2, repeated: false })
    expect((await api.here(a, crewId, eventId)).body.data.repeated).toBe(true)
    // The same tapper in another crew of theirs: that crew's own line.
    expect((await api.here(owner, second.crewId, eventId)).body.data).toEqual({ notified: 1, repeated: false })

    // The next night: a new occurrence, a new check-in — a new "We're here".
    const start = new Date(Date.now() - 30 * 60 * 1000)
    const next = await db.event_occurrences.create({
      data: { event_id: eventId, occurs_on: daysAgo(-1), start_time: start, end_time: new Date(Date.now() + 60 * 60 * 1000) },
      select: { id: true },
    })
    await db.event_check_ins.updateMany({ where: { event_id: eventId, user_id: owner.id }, data: { check_out_time: new Date(), status: "checked_out" } })
    await putInRoom({ eventId, occurrenceId: next.id, userId: owner.id })
    expect((await api.here(owner, crewId, eventId)).body.data).toEqual({ notified: 2, repeated: false })
    expect(await db.chat_messages.count({ where: { chat_group_id: roomId, type: "system", user_id: owner.id } })).toBe(2)
  })
})

describe("nobody kept apart shares a crew (C5, C6)", () => {
  it("withdraws an invite when the inviter blocks or unfriends the invitee, and the accept is the same 404", async () => {
    const owner = await person("ka-owner")
    const viaBlock = await person("ka-block")
    const viaUnfriend = await person("ka-unfriend")
    const keep = await person("ka-keep")
    await befriend(owner, viaBlock, viaUnfriend, keep)
    const made = await api.create(owner, { name: "Kept Apart", inviteUserIds: [viaBlock.id, viaUnfriend.id, keep.id] })
    const crewId = made.body.data.crewId as string
    expect(await db.crew_invites.count({ where: { crew_id: crewId } })).toBe(3)

    expect((await api.block(viaBlock, owner.id)).status).toBe(200)
    expect((await api.unfriend(owner, viaUnfriend.id)).status).toBe(200)
    expect(await inviteRow(crewId, viaBlock.id)).toBeNull()
    expect(await inviteRow(crewId, viaUnfriend.id)).toBeNull()
    expect((await api.join(viaBlock, crewId)).status).toBe(404)
    expect((await api.join(viaUnfriend, crewId)).status).toBe(404)
    // Nobody else's invite went with them.
    expect((await api.join(keep, crewId)).status).toBe(200)
  })

  it("refuses the accept when the inviter has left, or a block with ANY member arose after the invite", async () => {
    const owner = await person("ka2-owner")
    const inviter = await person("ka2-inviter")
    const member = await person("ka2-member")
    const late = await person("ka2-late")
    const blocked = await person("ka2-blocked")
    const { crewId } = await crewOf(owner, [inviter, member])
    await befriend(inviter, late, blocked)
    expect((await api.invite(inviter, crewId, [late.id, blocked.id])).body.data).toEqual({ invited: 2 })
    // A block between the invitee and a member who is not the inviter: the invite stands, the accept does not.
    await db.blocked_users.create({ data: { blocker_id: member.id, blocked_id: blocked.id } })
    expect((await api.join(blocked, crewId)).status).toBe(404)
    // The inviter leaves: their invite is no longer a friend asking from inside.
    await api.remove(inviter, crewId, inviter.id)
    expect((await api.join(late, crewId)).status).toBe(404)
    expect(await db.crew_members.count({ where: { crew_id: crewId, user_id: { in: [late.id, blocked.id] } } })).toBe(0)
  })

  it("skips an invitee kept apart from anybody in the crew without a word — `invited` is what was asked for", async () => {
    const owner = await person("ka3-owner")
    const member = await person("ka3-member")
    const closed = await person("ka3-closed")
    const fine = await person("ka3-fine")
    const { crewId } = await crewOf(owner, [member])
    await befriend(owner, closed, fine)
    // A closed conversation between the invitee and a member is kept apart like a block (C6).
    const [user1_id, user2_id] = conversationPair(member.id, closed.id)
    await db.private_conversations.create({ data: { user1_id, user2_id, closed_at: new Date(), closed_by: member.id, closed_reason: "unmatch" } })
    const before = await crewInvitePushes(closed.id)
    expect((await api.invite(owner, crewId, [closed.id, fine.id])).body.data).toEqual({ invited: 2 })
    expect(await inviteRow(crewId, closed.id)).toBeNull()
    expect(await crewInvitePushes(closed.id)).toBe(before)
    expect(await inviteRow(crewId, fine.id)).not.toBeNull()
  })

  it("hides crews from each other across a closed conversation, as across a block", async () => {
    const host = await person("kc-host")
    const { eventId, occurrenceId } = await liveEvent(host.id)
    const [a1, a2, b1, b2] = await Promise.all(["a1", "a2", "b1", "b2"].map((l) => person(`kc-${l}`)))
    const A = await crewOf(a1, [a2], "Crew A")
    const B = await crewOf(b1, [b2], "Crew B")
    for (const p of [a1, a2, b1, b2]) await putInRoom({ eventId, occurrenceId, userId: p.id })
    const sees = async (p: Person, crewId: string) =>
      (await api.atEvent(p, eventId)).body.data.crews.some((c: { crewId: string }) => c.crewId === crewId)
    expect(await sees(a1, B.crewId)).toBe(true)
    const [user1_id, user2_id] = conversationPair(a2.id, b2.id)
    await db.private_conversations.create({ data: { user1_id, user2_id, closed_at: new Date(), closed_by: a2.id, closed_reason: "unmatch" } })
    expect(await sees(a1, B.crewId)).toBe(false)
    expect(await sees(b1, A.crewId)).toBe(false)
  })

  it("two members who block each other are not listed to each other, nor heard in the crew chat", async () => {
    const owner = await person("kb-owner", "Meera Iyer")
    const x = await person("kb-x", "Xavier Dsouza")
    const y = await person("kb-y", "Yamini Rao")
    const { crewId, roomId } = await crewOf(owner, [x, y])
    await db.blocked_users.create({ data: { blocker_id: x.id, blocked_id: y.id } })
    const names = async (p: Person) =>
      (await api.detail(p, crewId)).body.data.members.map((m: { name: string }) => m.name).sort()
    expect(await names(x)).toEqual(["Meera", "Xavier"])
    expect(await names(y)).toEqual(["Meera", "Yamini"])
    expect(await names(owner)).toEqual(["Meera", "Xavier", "Yamini"])
    // Not counted to each other either: a size one bigger than the list says
    // somebody is hiding from you (step 9 review, H4).
    expect((await api.detail(x, crewId)).body.data.size).toBe(2)
    expect((await api.detail(y, crewId)).body.data.size).toBe(2)
    expect((await api.detail(owner, crewId)).body.data.size).toBe(3)
    expect((await api.mine(x)).body.data.crews.find((c: { crewId: string }) => c.crewId === crewId).size).toBe(2)
    // The chat: y's line reaches the owner, not x; the roster drops each for the other.
    expect((await api.send(y, roomId, "y says hi")).status).toBe(201)
    const read = async (p: Person) => (await api.read(p, roomId)).body.data.messages.map((m: { content: string }) => m.content)
    expect(await read(owner)).toContain("y says hi")
    expect(await read(x)).not.toContain("y says hi")
    const roster = (await api.roster(x, roomId)).body.data.participants.map((p: { name: string }) => p.name)
    expect(roster).not.toContain("Yamini")
  })
})

describe("what the viewer is shown is what the viewer can do (step 9 review, H4, M5)", () => {
  it("lists only an invite the accept would take: its sender still in and still a friend, nobody in it kept apart", async () => {
    const owner = await person("li-owner")
    const sender = await person("li-sender")
    const other = await person("li-other")
    const target = await person("li-target")
    const { crewId } = await crewOf(owner, [sender, other])
    await befriend(sender, target)
    expect((await api.invite(sender, crewId, [target.id])).body.data).toEqual({ invited: 1 })
    const listed = async () => (await api.mine(target)).body.data.invites.map((i: { crewId: string }) => i.crewId)
    expect(await listed()).toEqual([crewId])

    // A closed conversation with a member who did not send it.
    const [user1_id, user2_id] = conversationPair(other.id, target.id)
    const closed = await db.private_conversations.create({ data: { user1_id, user2_id, closed_at: new Date(), closed_by: target.id, closed_reason: "unmatch" } })
    expect(await listed()).toEqual([])
    expect((await api.join(target, crewId)).status).toBe(404)
    await db.private_conversations.delete({ where: { id: closed.id } })
    expect(await listed()).toEqual([crewId])

    // The sender suspended: no longer an active member.
    await db.user.update({ where: { id: sender.id }, data: { suspended_at: new Date() } })
    expect(await listed()).toEqual([])
    expect((await api.join(target, crewId)).status).toBe(404)
    await db.user.update({ where: { id: sender.id }, data: { suspended_at: null } })
    expect(await listed()).toEqual([crewId])

    // No longer friends with the sender (a row gone some other way than an unfriend, which drops the invite).
    const [f1, f2] = conversationPair(sender.id, target.id)
    await db.friendships.delete({ where: { user1_id_user2_id: { user1_id: f1, user2_id: f2 } } })
    expect(await listed()).toEqual([])
    expect((await api.join(target, crewId)).status).toBe(404)
  })

  it("marks each crewmate who is the viewer's friend, and nobody else", async () => {
    const owner = await person("fr-owner", "Meera Iyer")
    const x = await person("fr-x", "Xavier Dsouza")
    const y = await person("fr-y", "Yamini Rao")
    const { crewId } = await crewOf(owner, [x, y])
    const friendly = async (p: Person) =>
      Object.fromEntries((await api.detail(p, crewId)).body.data.members.map((m: { name: string; isFriend: boolean }) => [m.name, m.isFriend]))
    expect(await friendly(x)).toEqual({ Meera: true, Xavier: false, Yamini: false })
    expect(await friendly(owner)).toEqual({ Meera: false, Xavier: true, Yamini: true })
    await befriend(x, y)
    expect(await friendly(x)).toEqual({ Meera: true, Xavier: false, Yamini: true })
    // Still never an account id: the handle, whoever it is.
    const ids = (await api.detail(x, crewId)).body.data.members.map((m: { userId: string }) => m.userId)
    expect(ids).not.toContain(y.id)
    expect(ids).not.toContain(owner.id)
  })
})

describe("invites over time, and the owner's word (C8, C10)", () => {
  it("does not re-ask a no for 30 days, then asks again and pushes again", async () => {
    const owner = await person("dec-owner")
    const friend = await person("dec-friend")
    await befriend(owner, friend)
    const made = await api.create(owner, { name: "Ask Once", inviteUserIds: [friend.id] })
    const crewId = made.body.data.crewId as string
    expect((await api.decline(friend, crewId)).status).toBe(200)
    const pushes = await crewInvitePushes(friend.id)

    // Within 30 days: the same answer to the inviter, and nothing for the friend.
    expect((await api.invite(owner, crewId, [friend.id])).body.data).toEqual({ invited: 1 })
    expect((await inviteRow(crewId, friend.id))?.declined_at).toBeInstanceOf(Date)
    expect((await api.mine(friend)).body.data.invites).toEqual([])
    expect(await crewInvitePushes(friend.id)).toBe(pushes)

    // Thirty-one days on: a new ask — open again, and pushed.
    await db.crew_invites.update({ where: { id: (await inviteRow(crewId, friend.id))!.id }, data: { declined_at: daysAgo(31), created_at: daysAgo(40) } })
    expect((await api.invite(owner, crewId, [friend.id])).body.data).toEqual({ invited: 1 })
    expect((await inviteRow(crewId, friend.id))?.declined_at).toBeNull()
    expect((await api.mine(friend)).body.data.invites.map((i: { crewId: string }) => i.crewId)).toEqual([crewId])
    expect(await crewInvitePushes(friend.id)).toBe(pushes + 1)
  })

  it("lets an unanswered invite lapse after 14 days: not shown, not acceptable, and sendable again", async () => {
    const owner = await person("ttl-owner")
    const friend = await person("ttl-friend")
    await befriend(owner, friend)
    const crewId = (await api.create(owner, { name: "Lapsed", inviteUserIds: [friend.id] })).body.data.crewId as string
    await db.crew_invites.updateMany({ where: { crew_id: crewId }, data: { created_at: daysAgo(15) } })
    expect((await api.mine(friend)).body.data.invites).toEqual([])
    expect((await api.join(friend, crewId)).status).toBe(404)
    expect((await api.invite(owner, crewId, [friend.id])).body.data).toEqual({ invited: 1 })
    expect((await api.join(friend, crewId)).status).toBe(200)
  })

  it("keeps a removed member out: another member's invite is skipped, the owner's brings them back", async () => {
    const owner = await person("rm-owner")
    const member = await person("rm-member")
    const removed = await person("rm-removed")
    const { crewId } = await crewOf(owner, [member, removed])
    await befriend(member, removed)
    // Removed by the owner, through the handle the crew showed them.
    await db.profiles.update({ where: { id: removed.id }, data: { name: "Rafi Khan" } })
    const removedRef = (await api.detail(owner, crewId)).body.data.members.find((m: { name: string }) => m.name === "Rafi").userId
    expect((await api.remove(owner, crewId, removedRef)).body.data).toEqual({ dissolved: false })
    expect((await inviteRow(crewId, removed.id))?.removed_at).toBeInstanceOf(Date)

    expect((await api.invite(member, crewId, [removed.id])).body.data).toEqual({ invited: 1 })
    expect((await inviteRow(crewId, removed.id))?.removed_at).toBeInstanceOf(Date)
    expect((await api.join(removed, crewId)).status).toBe(404)

    expect((await api.invite(owner, crewId, [removed.id])).body.data).toEqual({ invited: 1 })
    expect((await inviteRow(crewId, removed.id))?.removed_at).toBeNull()
    expect((await api.join(removed, crewId)).status).toBe(200)
  })

  it("pushes one invite per inviter and invitee a day, whatever the crew — the invite itself still lands", async () => {
    const owner = await person("dup-owner")
    const friend = await person("dup-friend")
    await befriend(owner, friend)
    const one = (await api.create(owner, { name: "One", inviteUserIds: [friend.id] })).body.data.crewId as string
    const two = (await api.create(owner, { name: "Two", inviteUserIds: [friend.id] })).body.data.crewId as string
    expect(await crewInvitePushes(friend.id)).toBe(1)
    expect((await api.mine(friend)).body.data.invites.map((i: { crewId: string }) => i.crewId).sort()).toEqual([one, two].sort())
  })

  it("caps crews owned (3), made per day (3) and joined (10), and refuses an account with no age", async () => {
    const owner = await person("caps-owner")
    for (const n of [1, 2, 3]) expect((await api.create(owner, { name: `Mine ${n}` })).status).toBe(201)
    expect((await api.create(owner, { name: "Mine 4" })).status).toBe(409)
    // Hand one away by dissolving it (a crew of one): owned is 2 again, but three were made today.
    const solo = await db.crews.findFirstOrThrow({ where: { created_by: owner.id, name: "Mine 1" }, select: { id: true } })
    await db.crews.update({ where: { id: solo.id }, data: { dissolved_at: new Date() } })
    expect((await api.create(owner, { name: "Mine 4" })).status).toBe(429)

    // Ten crews joined: the eleventh accept is refused.
    const joiner = await person("caps-joiner")
    const hosts = await Promise.all(Array.from({ length: 11 }, (_, i) => person(`caps-host-${i}`)))
    const crews: string[] = []
    for (const h of hosts) {
      await befriend(h, joiner)
      crews.push((await api.create(h, { name: `Host ${crews.length}`, inviteUserIds: [joiner.id] })).body.data.crewId)
    }
    for (const c of crews.slice(0, 10)) expect((await api.join(joiner, c)).status).toBe(200)
    expect((await api.join(joiner, crews[10])).status).toBe(409)

    const ageless = await person("caps-ageless")
    await db.profiles.update({ where: { id: ageless.id }, data: { age: null, date_of_birth: null } })
    expect((await api.create(ageless, { name: "No Age" })).status).toBe(403)
  })
})

describe("standing: active members only, an owner who can act, and the sweeper's repair", () => {
  it("hands an owner's crew to the longest-standing ACTIVE member, skipping a suspended one", async () => {
    const owner = await person("ho-owner")
    const early = await person("ho-early")
    const later = await person("ho-later")
    const last = await person("ho-last")
    const { crewId } = await crewOf(owner, [early, later, last])
    await db.user.update({ where: { id: early.id }, data: { suspended_at: new Date() } })
    expect((await api.remove(owner, crewId, owner.id)).body.data).toEqual({ dissolved: false })
    const roles = await db.crew_members.findMany({ where: { crew_id: crewId }, select: { user_id: true, role: true } })
    expect(roles.find((r) => r.user_id === later.id)?.role).toBe("owner")
    expect(roles.find((r) => r.user_id === early.id)?.role).toBe("member")
  })

  it("dissolves a crew left with one ACTIVE member, a suspended one not counting", async () => {
    const owner = await person("am-owner")
    const susp = await person("am-susp")
    const leaver = await person("am-leaver")
    const { crewId } = await crewOf(owner, [susp, leaver])
    await db.user.update({ where: { id: susp.id }, data: { suspended_at: new Date() } })
    expect((await api.remove(leaver, crewId, leaver.id)).body.data).toEqual({ dissolved: true })
  })

  it("repairs on the sweep what a suspension or a failed settle left: below two dissolves, no active owner is handed on", async () => {
    const [o1, m1] = [await person("rp-o1"), await person("rp-m1")]
    const [o2, m2, m3] = [await person("rp-o2"), await person("rp-m2"), await person("rp-m3")]
    const [o3, m4] = [await person("rp-o3"), await person("rp-m4")]
    const pair = await crewOf(o1, [m1], "Pair")
    const trio = await crewOf(o2, [m2, m3], "Trio")
    const ghost = await crewOf(o3, [m4], "Ghost")
    // A suspension writes no crew row; a settle that failed after an erasure left a member row gone.
    await db.user.update({ where: { id: m1.id }, data: { suspended_at: new Date() } })
    await db.user.update({ where: { id: o2.id }, data: { suspended_at: new Date() } })
    await db.crew_members.delete({ where: { crew_id_user_id: { crew_id: ghost.crewId, user_id: m4.id } } })
    // The pair is young but had two members: not waiting (step 9 review). The
    // ghost is down to one member row, so only its age says it is not new.
    await db.crews.update({ where: { id: ghost.crewId }, data: { created_at: daysAgo(15) } })

    const result = await repairCrews()
    expect(result.dissolved).toBeGreaterThanOrEqual(2)
    const state = async (id: string) => db.crews.findUniqueOrThrow({ where: { id }, select: { dissolved_at: true } })
    expect((await state(pair.crewId)).dissolved_at).toBeInstanceOf(Date)
    expect((await state(ghost.crewId)).dissolved_at).toBeInstanceOf(Date)
    expect((await state(trio.crewId)).dissolved_at).toBeNull()
    expect((await db.crew_members.findFirstOrThrow({ where: { crew_id: trio.crewId, role: "owner" } })).user_id).toBe(m2.id)
    expect((await db.chat_groups.findUniqueOrThrow({ where: { id: pair.roomId }, select: { status: true } })).status).toBe("archived")
    // Idempotent: a second pass finds nothing of theirs.
    await repairCrews()
    expect(await db.crew_members.count({ where: { crew_id: trio.crewId, role: "owner" } })).toBe(1)
  })

  const standing = async (crewId: string) =>
    (await db.crews.findUniqueOrThrow({ where: { id: crewId }, select: { dissolved_at: true } })).dissolved_at === null

  it("leaves a new crew of one standing while its invites are out, and the accept after the sweep lands (step 9 review, C1)", async () => {
    const owner = await person("wait-owner")
    const [f1, f2] = [await person("wait-f1"), await person("wait-f2")]
    await befriend(owner, f1, f2)
    const crewId = (await api.create(owner, { name: "Waiting Lot", inviteUserIds: [f1.id, f2.id] })).body.data.crewId as string
    expect(await crewsToRepair()).not.toContain(crewId)
    await repairCrews()
    expect(await standing(crewId)).toBe(true)
    expect((await api.mine(f1)).body.data.invites.map((i: { crewId: string }) => i.crewId)).toEqual([crewId])
    expect((await api.join(f1, crewId)).status).toBe(200)
    expect((await api.detail(f1, crewId)).body.data.size).toBe(2)
  })

  it("waits on an invite as on a young crew: an old crew asked a friend today stands, and the settle re-reads it under the lock", async () => {
    const owner = await person("wait2-owner")
    const friend = await person("wait2-friend")
    await befriend(owner, friend)
    const crewId = (await api.create(owner, { name: "Slow Lot" })).body.data.crewId as string
    // Young, nobody asked yet: a crew of one is how every crew starts.
    expect(await crewsToRepair()).not.toContain(crewId)
    expect(await settleCrew(crewId, { graceWhileInviting: true })).toEqual({ dissolved: false })
    // Older than an invite lives, nobody asked: the sweep's to settle.
    await db.crews.update({ where: { id: crewId }, data: { created_at: daysAgo(20) } })
    expect(await crewsToRepair()).toContain(crewId)
    // The owner asks before the settle takes the lock: the settle sees the invite.
    expect((await api.invite(owner, crewId, [friend.id])).body.data).toEqual({ invited: 1 })
    expect(await settleCrew(crewId, { graceWhileInviting: true })).toEqual({ dissolved: false })
    expect(await crewsToRepair()).not.toContain(crewId)
    expect((await api.join(friend, crewId)).status).toBe(200)
  })

  it("dissolves a crew of one whose invites all lapsed or were declined", async () => {
    const owner = await person("lap-owner")
    const [no, slow] = [await person("lap-no"), await person("lap-slow")]
    await befriend(owner, no, slow)
    const { crewId, chatGroupId } = (await api.create(owner, { name: "Nobody Came", inviteUserIds: [no.id, slow.id] })).body.data
    expect((await api.decline(no, crewId)).status).toBe(200)
    await db.crew_invites.updateMany({ where: { crew_id: crewId, invited_user_id: slow.id }, data: { created_at: daysAgo(15) } })
    await db.crews.update({ where: { id: crewId }, data: { created_at: daysAgo(15) } })
    expect(await crewsToRepair()).toContain(crewId)
    await repairCrews()
    expect(await standing(crewId)).toBe(false)
    expect((await db.chat_groups.findUniqueOrThrow({ where: { id: chatGroupId }, select: { status: true } })).status).toBe("archived")
    expect((await api.join(slow, crewId)).status).toBe(404)
  })

  it("does not wait on an invite whose sender is no longer an active member, nor on an owner's removal marker", async () => {
    const owner = await person("nw-owner")
    const mate = await person("nw-mate")
    const asked = await person("nw-asked")
    const { crewId } = await crewOf(owner, [mate])
    await befriend(mate, asked)
    expect((await api.invite(mate, crewId, [asked.id])).body.data).toEqual({ invited: 1 })
    await db.user.update({ where: { id: mate.id }, data: { suspended_at: new Date() } })
    // The only open invite came from the suspended mate: the accept would refuse it, so the crew is not waiting.
    expect(await crewsToRepair()).toContain(crewId)
    expect(await settleCrew(crewId, { graceWhileInviting: true })).toEqual({ dissolved: true })
    expect((await api.join(asked, crewId)).status).toBe(404)

    const owner2 = await person("nw-owner2")
    const [kept, gone] = [await person("nw-kept"), await person("nw-gone")]
    const second = await crewOf(owner2, [kept, gone], "Marked")
    // The owner removes one (a marker row, removed_at), then the other is suspended: one active, one fresh marker.
    await db.profiles.update({ where: { id: gone.id }, data: { name: "Gautam Rao" } })
    const goneRef = (await api.detail(owner2, second.crewId)).body.data.members.find((m: { name: string }) => m.name === "Gautam").userId
    expect((await api.remove(owner2, second.crewId, goneRef)).body.data).toEqual({ dissolved: false })
    expect((await inviteRow(second.crewId, gone.id))?.removed_at).toBeInstanceOf(Date)
    await db.crew_invites.updateMany({ where: { crew_id: second.crewId, invited_user_id: gone.id }, data: { created_at: new Date() } })
    await db.user.update({ where: { id: kept.id }, data: { suspended_at: new Date() } })
    expect(await crewsToRepair()).toContain(second.crewId)
    expect(await settleCrew(second.crewId, { graceWhileInviting: true })).toEqual({ dissolved: true })
  })

  it("keeps the crew-chat ban a suspension wrote after the reinstate (D: a ban only a person lifts)", async () => {
    const owner = await person("sr-owner")
    const subject = await person("sr-subject")
    const third = await person("sr-third")
    const admin = await makeUser(testId("sr-admin"), "app_admin")
    users.push(admin)
    const { roomId } = await crewOf(owner, [subject, third])
    await db.$transaction((tx) => applySuspension(tx, subject.id, admin))
    await db.$transaction((tx) => liftSuspension(tx, subject.id))
    const row = await db.chat_group_members.findUniqueOrThrow({
      where: { chat_group_id_user_id: { chat_group_id: roomId, user_id: subject.id } },
      select: { status: true },
    })
    expect(row.status).toBe("banned")
    expect(await canJoinChat(subject.id, roomId)).toBe(false)
  })
})

describe("account erasure inside the transaction (SEC-22, MUST)", () => {
  const erase = (p: Person) =>
    (accountRoute.DELETE as unknown as (r: NextRequest) => Promise<Response>)(
      new NextRequest("http://localhost/api/mobile/account", { method: "DELETE", headers: { authorization: `Bearer ${p.token}` } })
    )

  it("an erased owner's crew passes on, and every invite to or from them goes", async () => {
    const owner = await person("eo-owner")
    const m1 = await person("eo-m1")
    const m2 = await person("eo-m2")
    const toThem = await person("eo-to")
    const fromThem = await person("eo-from")
    const { crewId } = await crewOf(owner, [m1, m2])
    await befriend(owner, fromThem)
    await befriend(m1, toThem)
    const other = await crewOf(toThem, [fromThem], "Other")
    await befriend(toThem, owner)
    expect((await api.invite(toThem, other.crewId, [owner.id])).status).toBe(200)
    expect((await api.invite(owner, crewId, [fromThem.id])).status).toBe(200)
    expect(await db.crew_invites.count({ where: { OR: [{ invited_user_id: owner.id }, { invited_by: owner.id }] } })).toBe(2)

    expect((await erase(owner)).status).toBe(200)
    expect(await db.crew_invites.count({ where: { OR: [{ invited_user_id: owner.id }, { invited_by: owner.id }] } })).toBe(0)
    const left = await db.crew_members.findMany({ where: { crew_id: crewId }, select: { user_id: true, role: true } })
    expect(left.map((m) => m.user_id).sort()).toEqual([m1.id, m2.id].sort())
    expect(left.filter((m) => m.role === "owner").map((m) => m.user_id)).toEqual([m1.id])
  })
})

describe("reports and the moderator's levers (C12)", () => {
  it("files a crew report once, with the card as it read; a moderator hides it off the cards, then dissolves it", async () => {
    const host = await person("mod-host")
    const { eventId, occurrenceId } = await liveEvent(host.id)
    const a = await person("mod-a")
    const b = await person("mod-b")
    const viewer = await person("mod-viewer")
    const viewerMate = await person("mod-viewer-mate")
    const reported = await crewOf(a, [b], "Reported Lot")
    await crewOf(viewer, [viewerMate], "Viewers")
    for (const p of [a, b, viewer, viewerMate]) await putInRoom({ eventId, occurrenceId, userId: p.id })
    const sees = async () =>
      (await api.atEvent(viewer, eventId)).body.data.crews.some((c: { crewId: string }) => c.crewId === reported.crewId)
    expect(await sees()).toBe(true)

    expect((await api.report(viewer, reported.crewId, { reason: "offensive", description: "rude name" })).status).toBe(201)
    expect((await api.report(viewer, reported.crewId)).status).toBe(201)
    const reports = await db.message_reports.findMany({ where: { message_type: "crew", message_id: reported.crewId } })
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ reporter_id: viewer.id, reason: "offensive", excerpt: "Reported Lot" })
    expect((await api.report(viewer, "00000000-0000-4000-8000-000000000000")).status).toBe(404)

    const admin = await makeUser(testId("mod-admin"), "app_admin")
    users.push(admin)
    session = { user: { id: admin, role: "app_admin" } }
    await resolveReport("message", reports[0].id, "hide_crew")
    expect((await db.crews.findUniqueOrThrow({ where: { id: reported.crewId }, select: { hidden_at: true } })).hidden_at).toBeInstanceOf(Date)
    expect(await sees()).toBe(false)
    // Its members keep their crew and its chat.
    expect((await api.detail(a, reported.crewId)).status).toBe(200)
    expect(await db.audit_logs.count({ where: { action: "report.hide_crew", resource_id: reports[0].id } })).toBe(1)

    // A second report, then a dissolve: the crew ends and its chat closes.
    const second = await person("mod-second")
    expect((await api.report(second, reported.crewId)).status).toBe(201)
    const pending = await db.message_reports.findFirstOrThrow({ where: { message_id: reported.crewId, status: "pending" } })
    await resolveReport("message", pending.id, "dissolve_crew")
    expect((await db.crews.findUniqueOrThrow({ where: { id: reported.crewId }, select: { dissolved_at: true } })).dissolved_at).toBeInstanceOf(Date)
    expect((await db.chat_groups.findUniqueOrThrow({ where: { id: reported.roomId }, select: { status: true } })).status).toBe("archived")
    expect((await api.detail(a, reported.crewId)).status).toBe(404)
    // The levers are for crew reports only.
    await expect(resolveReport("message", pending.id, "hide_crew")).rejects.toThrow()
    session = null
  })
})

describe("the cards a page at a time", () => {
  it("orders by how many are here, and pages with total and hasMore", async () => {
    const host = await person("pg-host")
    const { eventId, occurrenceId } = await liveEvent(host.id)
    const viewer = await person("pg-viewer")
    const mate = await person("pg-mate")
    await crewOf(viewer, [mate], "Pager")
    const crews: { crewId: string }[] = []
    for (const n of [2, 3, 2]) {
      const people = await Promise.all(Array.from({ length: n }, (_, i) => person(`pg-${crews.length}-${i}`)))
      crews.push(await crewOf(people[0], people.slice(1), `Page ${crews.length}`))
      for (const p of people) await putInRoom({ eventId, occurrenceId, userId: p.id })
    }
    for (const p of [viewer, mate]) await putInRoom({ eventId, occurrenceId, userId: p.id })
    const first = await api.atEvent(viewer, eventId, "?limit=2")
    expect(first.body.data).toMatchObject({ total: 3, hasMore: true })
    expect(first.body.data.crews).toHaveLength(2)
    expect(first.body.data.crews[0].crewId).toBe(crews[1].crewId)
    const rest = await api.atEvent(viewer, eventId, "?limit=2&offset=2")
    expect(rest.body.data).toMatchObject({ total: 3, hasMore: false })
    expect(rest.body.data.crews).toHaveLength(1)
    // A limit past the most is held to it, and garbage is the default — never a 500.
    expect((await api.atEvent(viewer, eventId, "?limit=999&offset=abc")).status).toBe(200)
  })
})

/* -------------------------------------------------------------------------- */
/* Follow-up (review of the merged step 8 code)                                */
/* -------------------------------------------------------------------------- */

describe("nothing a crew does tells anybody about a friend (step 8 follow-up)", () => {
  it("answers 409 on the seats asked for, before the silent skips — a skipped friend changes nothing", async () => {
    const owner = await person("fu-full-owner")
    const mate = await person("fu-full-mate")
    const { crewId } = await crewOf(owner, [mate])
    // Eight more members (fixture rows) and one open invite: 10 + 1 = 11 seats.
    const fillers = await Promise.all(Array.from({ length: 8 }, (_, i) => person(`fu-full-${i}`)))
    await db.crew_members.createMany({ data: fillers.map((f) => ({ crew_id: crewId, user_id: f.id, consented_reveal_at: new Date() })) })
    const pending = await person("fu-full-pending")
    await db.crew_invites.create({ data: { crew_id: crewId, invited_user_id: pending.id, invited_by: owner.id } })
    // Two friends asked for: one kept apart from a member (a closed conversation), one not.
    const apart = await person("fu-full-apart")
    const fine = await person("fu-full-fine")
    await befriend(owner, apart, fine)
    const [user1_id, user2_id] = conversationPair(mate.id, apart.id)
    await db.private_conversations.create({ data: { user1_id, user2_id, closed_at: new Date(), closed_by: mate.id, closed_reason: "unmatch" } })
    // 11 + 2 asked > 12: 409 — whether or not one of them would have been skipped.
    expect((await api.invite(owner, crewId, [apart.id, fine.id])).status).toBe(409)
    expect(await db.crew_invites.count({ where: { crew_id: crewId, invited_user_id: { in: [apart.id, fine.id] } } })).toBe(0)
    // One seat asked for: 200 either way, and only the one not kept apart is written.
    expect((await api.invite(owner, crewId, [apart.id])).body.data).toEqual({ invited: 1 })
    expect((await api.invite(owner, crewId, [fine.id])).body.data).toEqual({ invited: 1 })
    expect((await db.crew_invites.findMany({ where: { crew_id: crewId, invited_user_id: { in: [apart.id, fine.id] } }, select: { invited_user_id: true } })).map((i) => i.invited_user_id)).toEqual([fine.id])
  })

  it("keeps an owner's removal and a friend's decline after the owner erases their account", async () => {
    const owner = await person("fu-er-owner")
    const mate = await person("fu-er-mate")
    const third = await person("fu-er-third")
    const removed = await person("fu-er-removed", "Rafi Khan")
    const decliner = await person("fu-er-decliner")
    const { crewId } = await crewOf(owner, [mate, third, removed])
    await befriend(owner, decliner)
    expect((await api.invite(owner, crewId, [decliner.id])).status).toBe(200)
    expect((await api.decline(decliner, crewId)).status).toBe(200)
    const ref = (await api.detail(owner, crewId)).body.data.members.find((m: { name: string }) => m.name === "Rafi").userId
    expect((await api.remove(owner, crewId, ref)).status).toBe(200)

    const erase = await (accountRoute.DELETE as unknown as (r: NextRequest) => Promise<Response>)(
      new NextRequest("http://localhost/api/mobile/account", { method: "DELETE", headers: { authorization: `Bearer ${owner.token}` } })
    )
    expect(erase.status).toBe(200)
    // The marker and the decline stand: a member's invite (not the new owner's —
    // `mate` took the crew over) skips both, and nobody is pushed.
    expect((await inviteRow(crewId, removed.id))?.removed_at).toBeInstanceOf(Date)
    expect((await inviteRow(crewId, decliner.id))?.declined_at).toBeInstanceOf(Date)
    expect((await db.crew_members.findFirstOrThrow({ where: { crew_id: crewId, role: "owner" } })).user_id).toBe(mate.id)
    await befriend(third, removed, decliner)
    const before = (await crewInvitePushes(removed.id)) + (await crewInvitePushes(decliner.id))
    expect((await api.invite(third, crewId, [removed.id, decliner.id])).body.data).toEqual({ invited: 2 })
    expect((await api.join(removed, crewId)).status).toBe(404)
    expect((await api.join(decliner, crewId)).status).toBe(404)
    expect((await crewInvitePushes(removed.id)) + (await crewInvitePushes(decliner.id))).toBe(before)
  })

  it("hands a crew to the longest-standing member who can own another, skipping one who already owns three", async () => {
    const owner = await person("fu-cap-owner")
    const busy = await person("fu-cap-busy")
    const next = await person("fu-cap-next")
    const { crewId } = await crewOf(owner, [busy, next])
    for (const n of [1, 2, 3]) expect((await api.create(busy, { name: `Busy ${n}` })).status).toBe(201)
    expect((await api.remove(owner, crewId, owner.id)).body.data).toEqual({ dissolved: false })
    const owners = await db.crew_members.findMany({ where: { crew_id: crewId, role: "owner" }, select: { user_id: true } })
    expect(owners.map((o) => o.user_id)).toEqual([next.id])
  })

  it("a crew a moderator hid takes nobody new and is not on an invitee's list", async () => {
    const owner = await person("fu-hid-owner")
    const mate = await person("fu-hid-mate")
    const invitee = await person("fu-hid-invitee")
    const later = await person("fu-hid-later")
    const { crewId } = await crewOf(owner, [mate])
    await befriend(owner, invitee, later)
    expect((await api.invite(owner, crewId, [invitee.id])).status).toBe(200)
    await db.crews.update({ where: { id: crewId }, data: { hidden_at: new Date() } })
    expect((await api.mine(invitee)).body.data.invites).toEqual([])
    expect((await api.join(invitee, crewId)).status).toBe(404)
    expect((await api.invite(owner, crewId, [later.id])).status).toBe(403)
    // Its members keep it.
    expect((await api.detail(mate, crewId)).status).toBe(200)
  })

  it("an unmatch withdraws the crew invites between the two, as a block does", async () => {
    const owner = await person("fu-um-owner")
    const mate = await person("fu-um-mate")
    const friend = await person("fu-um-friend")
    const { crewId } = await crewOf(owner, [mate])
    await befriend(owner, friend)
    expect((await api.invite(owner, crewId, [friend.id])).status).toBe(200)
    const [user1_id, user2_id] = conversationPair(owner.id, friend.id)
    const convo = await db.private_conversations.create({ data: { user1_id, user2_id }, select: { id: true } })
    expect((await api.unmatch(friend, convo.id)).status).toBe(200)
    expect(await inviteRow(crewId, friend.id)).toBeNull()
    expect((await api.mine(friend)).body.data.invites).toEqual([])
    expect((await api.join(friend, crewId)).status).toBe(404)

    // An invite whose inviter is kept apart from the invitee by a path that
    // never withdrew it (a row written directly) is still not on the list.
    const other = await person("fu-um-other")
    await befriend(mate, other)
    expect((await api.invite(mate, crewId, [other.id])).status).toBe(200)
    expect((await api.mine(other)).body.data.invites).toHaveLength(1)
    const [o1, o2] = conversationPair(mate.id, other.id)
    await db.private_conversations.create({ data: { user1_id: o1, user2_id: o2, closed_at: new Date(), closed_by: other.id, closed_reason: "unmatch" } })
    expect((await api.mine(other)).body.data.invites).toEqual([])
  })
})
