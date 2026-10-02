import { createServer } from "http"
import type { AddressInfo } from "net"
import { NextRequest } from "next/server"
import { io as connect, type Socket as ClientSocket } from "socket.io-client"

import { conversationPair } from "@/lib/conversations"
import { signAccessToken } from "@/lib/mobile-auth"
import { initSocketServer } from "@/lib/socket-server"
import { stopSponsoredScheduler } from "@/lib/sponsored-scheduler"

import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, onboard, putInRoom, testId } from "./helpers"

/**
 * The fixture world for the crew suites (step 8): people who are friends,
 * crews made and joined through the real routes, live events, and the real
 * socket server. Not a suite: `jest.integration.config.ts` runs `*.itest.ts`.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
export const routes = {
  crews: require("@/app/api/mobile/crews/route") as typeof import("@/app/api/mobile/crews/route"),
  crew: require("@/app/api/mobile/crews/[crewId]/route") as typeof import("@/app/api/mobile/crews/[crewId]/route"),
  invites: require("@/app/api/mobile/crews/[crewId]/invites/route") as typeof import("@/app/api/mobile/crews/[crewId]/invites/route"),
  join: require("@/app/api/mobile/crews/[crewId]/join/route") as typeof import("@/app/api/mobile/crews/[crewId]/join/route"),
  member: require("@/app/api/mobile/crews/[crewId]/members/[userId]/route") as typeof import("@/app/api/mobile/crews/[crewId]/members/[userId]/route"),
  here: require("@/app/api/mobile/crews/[crewId]/here/route") as typeof import("@/app/api/mobile/crews/[crewId]/here/route"),
  reveal: require("@/app/api/mobile/crews/[crewId]/reveal/route") as typeof import("@/app/api/mobile/crews/[crewId]/reveal/route"),
  eventCrews: require("@/app/api/mobile/events/[eventId]/crews/route") as typeof import("@/app/api/mobile/events/[eventId]/crews/route"),
  crewLike: require("@/app/api/mobile/events/[eventId]/crews/[crewId]/like/route") as typeof import("@/app/api/mobile/events/[eventId]/crews/[crewId]/like/route"),
  personLike: require("@/app/api/mobile/events/[eventId]/matches/likes/route") as typeof import("@/app/api/mobile/events/[eventId]/matches/likes/route"),
  prefs: require("@/app/api/mobile/events/[eventId]/matches/preferences/route") as typeof import("@/app/api/mobile/events/[eventId]/matches/preferences/route"),
  blends: require("@/app/api/mobile/blends/route") as typeof import("@/app/api/mobile/blends/route"),
  messages: require("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/messages/route"),
  participants: require("@/app/api/mobile/chat/groups/[chatGroupId]/participants/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/participants/route"),
  leave: require("@/app/api/mobile/chat/groups/[chatGroupId]/leave/route") as typeof import("@/app/api/mobile/chat/groups/[chatGroupId]/leave/route"),
  block: require("@/app/api/mobile/users/[userId]/block/route") as typeof import("@/app/api/mobile/users/[userId]/block/route"),
  account: require("@/app/api/mobile/account/route") as typeof import("@/app/api/mobile/account/route"),
}
/* eslint-enable @typescript-eslint/no-require-imports */

type Handler = (req: NextRequest, ctx: { params: Promise<never> }) => Promise<Response>
export interface Person {
  id: string
  token: string
}

export const world = { users: [] as string[], events: [] as string[] }

/** An onboarded adult with a first and last name, so "first name only" can be checked. */
export async function person(label: string, name = `Asha ${label} Rao`): Promise<Person> {
  const id = await makeUser(testId(label))
  world.users.push(id)
  await onboard(id)
  await db.profiles.update({ where: { id }, data: { name, age: 27 } })
  return { id, token: signAccessToken(id, `${id}@itest.invalid`) }
}

export async function befriend(a: Person, ...others: Person[]) {
  await db.friendships.createMany({
    data: others.map((b) => {
      const [user1_id, user2_id] = conversationPair(a.id, b.id)
      return { user1_id, user2_id }
    }),
    skipDuplicates: true,
  })
}

export async function call(
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

export const api = {
  create: (as: Person, body: Record<string, unknown>) =>
    call(routes.crews.POST, "/api/mobile/crews", as, { method: "POST", body: { revealConsent: true, ...body } }),
  detail: (as: Person, crewId: string) => call(routes.crew.GET, `/api/mobile/crews/${crewId}`, as, { params: { crewId } }),
  invite: (as: Person, crewId: string, userIds: string[]) =>
    call(routes.invites.POST, `/api/mobile/crews/${crewId}/invites`, as, { method: "POST", body: { userIds }, params: { crewId } }),
  join: (as: Person, crewId: string, body: Record<string, unknown> = { revealConsent: true }) =>
    call(routes.join.POST, `/api/mobile/crews/${crewId}/join`, as, { method: "POST", body, params: { crewId } }),
  remove: (as: Person, crewId: string, userId: string) =>
    call(routes.member.DELETE, `/api/mobile/crews/${crewId}/members/${userId}`, as, { method: "DELETE", params: { crewId, userId } }),
  settings: (as: Person, crewId: string, keepMeAnonymous: boolean) =>
    call(routes.member.PATCH, `/api/mobile/crews/${crewId}/members/${as.id}`, as, {
      method: "PATCH",
      body: { keepMeAnonymous },
      params: { crewId, userId: as.id },
    }),
  here: (as: Person, crewId: string, eventId: string) =>
    call(routes.here.POST, `/api/mobile/crews/${crewId}/here`, as, { method: "POST", body: { eventId }, params: { crewId } }),
  reveal: (as: Person, crewId: string, eventId: string) =>
    call(routes.reveal.POST, `/api/mobile/crews/${crewId}/reveal`, as, { method: "POST", body: { eventId }, params: { crewId } }),
  atEvent: (as: Person, eventId: string) => call(routes.eventCrews.GET, `/api/mobile/events/${eventId}/crews`, as, { params: { eventId } }),
  likeCrew: (as: Person, eventId: string, crewId: string, asCrewId?: string) =>
    call(routes.crewLike.POST, `/api/mobile/events/${eventId}/crews/${crewId}/like`, as, {
      method: "POST",
      body: asCrewId ? { asCrewId } : {},
      params: { eventId, crewId },
    }),
  likePerson: (as: Person, eventId: string, userId: string, asCrewId?: string) =>
    call(routes.personLike.POST, `/api/mobile/events/${eventId}/matches/likes`, as, {
      method: "POST",
      body: { userId, ...(asCrewId && { asCrewId }) },
      params: { eventId },
    }),
  prefs: (as: Person, eventId: string, body: Record<string, unknown>) =>
    call(routes.prefs.PUT, `/api/mobile/events/${eventId}/matches/preferences`, as, { method: "PUT", body, params: { eventId } }),
  blends: (as: Person) => call(routes.blends.GET, "/api/mobile/blends", as),
  read: (as: Person, g: string) => call(routes.messages.GET, `/api/mobile/chat/groups/${g}/messages`, as, { params: { chatGroupId: g } }),
  send: (as: Person, g: string, content = `hi ${testId("m")}`) =>
    call(routes.messages.POST, `/api/mobile/chat/groups/${g}/messages`, as, { method: "POST", body: { content }, params: { chatGroupId: g } }),
  roster: (as: Person, g: string) =>
    call(routes.participants.GET, `/api/mobile/chat/groups/${g}/participants`, as, { params: { chatGroupId: g } }),
  leave: (as: Person, g: string) =>
    call(routes.leave.POST, `/api/mobile/chat/groups/${g}/leave`, as, { method: "POST", params: { chatGroupId: g } }),
  block: (as: Person, userId: string) =>
    call(routes.block.POST, `/api/mobile/users/${userId}/block`, as, { method: "POST", params: { userId } }),
}

/** A crew made through the route, everyone in it a friend of the creator and joined through the route. */
export async function crewOf(owner: Person, members: Person[], name = "Saturday Lot") {
  await befriend(owner, ...members)
  const made = await api.create(owner, { name, inviteUserIds: members.map((m) => m.id) })
  expect(made.status).toBe(201)
  for (const m of members) expect((await api.join(m, made.body.data.crewId)).status).toBe(200)
  return { crewId: made.body.data.crewId as string, roomId: made.body.data.chatGroupId as string }
}

/** A live event (now −1 h … now +1 h) with its room, and its one occurrence. */
export async function liveEvent(host: string) {
  const eventId = await makeEvent(host)
  world.events.push(eventId)
  await db.chat_groups.create({ data: { event_id: eventId, name: "room" } })
  return { eventId, occurrenceId: await occurrenceOf(eventId) }
}

/** Checked in now, with a pseudonym in the event's room — what the check-in route writes. */
export async function arrive(eventId: string, occurrenceId: string, p: Person, pseudonym = testId("Otter")) {
  await putInRoom({ eventId, occurrenceId, userId: p.id })
  const room = await db.chat_groups.findUniqueOrThrow({ where: { event_id: eventId }, select: { id: true } })
  await db.chat_group_members.upsert({
    where: { chat_group_id_user_id: { chat_group_id: room.id, user_id: p.id } },
    create: { chat_group_id: room.id, user_id: p.id, anonymous_name: pseudonym },
    update: {},
  })
  return pseudonym
}

/* -------------------------------------------------------------------------- */
/* The real socket server                                                      */
/* -------------------------------------------------------------------------- */

export function socketHarness() {
  const httpServer = createServer()
  const io = initSocketServer(httpServer)
  const clients: ClientSocket[] = []

  const online = async (p: Person) => {
    const { port } = httpServer.address() as AddressInfo
    const socket = connect(`http://localhost:${port}`, { auth: { token: p.token }, transports: ["websocket"], reconnection: false })
    clients.push(socket)
    const heard = {
      message: [] as { message: { content: string; userName: string; userId: string } }[],
      typing: [] as { userName: string }[],
      refused: [] as unknown[],
    }
    socket.on("chat:message", (m) => heard.message.push(m))
    socket.on("chat:typing", (m) => heard.typing.push(m))
    socket.on("error", (e) => heard.refused.push(e))
    await new Promise<void>((resolve, reject) => {
      socket.on("connect", () => resolve())
      socket.on("connect_error", reject)
    })
    return { socket, heard, id: p.id }
  }
  const inRoom = async (chatGroupId: string, userId: string) =>
    (await io.in(`chat:${chatGroupId}`).fetchSockets()).some((s) => s.data.userId === userId)
  const joins = async (c: Awaited<ReturnType<typeof online>>, chatGroupId: string): Promise<boolean> => {
    const before = c.heard.refused.length
    c.socket.emit("join:chat", chatGroupId)
    await until(async () => c.heard.refused.length > before || (await inRoom(chatGroupId, c.id)))
    return inRoom(chatGroupId, c.id)
  }
  return {
    online,
    inRoom,
    joins,
    start: () => new Promise<void>((resolve) => httpServer.listen(0, resolve)),
    stop: async () => {
      for (const c of clients) c.close()
      stopSponsoredScheduler()
      globalThis.__blendnSocketIo = null
      await new Promise<void>((resolve) => io.close(() => resolve()))
    },
  }
}

export async function until(check: () => boolean | Promise<boolean>, ms = 3000) {
  for (let waited = 0; waited < ms; waited += 25) {
    if (await check()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return false
}

/** Everything the crew suites made, children first: every crew foreign key is RESTRICT. */
export async function cleanupCrewWorld() {
  const users = world.users
  const crews = (
    await db.crews.findMany({
      where: { OR: [{ created_by: { in: users } }, { members: { some: { user_id: { in: users } } } }] },
      select: { id: true },
    })
  ).map((c) => c.id)
  const blends = (
    await db.blends.findMany({
      where: { OR: [{ a_crew_id: { in: crews } }, { b_crew_id: { in: crews } }, { b_user_id: { in: users } }] },
      select: { id: true },
    })
  ).map((b) => b.id)
  const rooms = { chat_group: { OR: [{ crew_id: { in: crews } }, { blend_id: { in: blends } }] } }
  await db.moderation_flags.deleteMany({ where: { user_id: { in: users } } })
  await db.message_reports.deleteMany({ where: { reporter_id: { in: users } } })
  await db.chat_messages.deleteMany({ where: rooms })
  await db.chat_group_members.deleteMany({ where: rooms })
  await db.chat_groups.deleteMany({ where: { OR: [{ crew_id: { in: crews } }, { blend_id: { in: blends } }] } })
  await db.blends.deleteMany({ where: { id: { in: blends } } })
  await db.crew_likes.deleteMany({
    where: { OR: [{ from_crew_id: { in: crews } }, { to_crew_id: { in: crews } }, { liked_by_user_id: { in: users } }] },
  })
  await db.crew_invites.deleteMany({ where: { crew_id: { in: crews } } })
  await db.crew_members.deleteMany({ where: { crew_id: { in: crews } } })
  await db.crews.deleteMany({ where: { id: { in: crews } } })
  await db.notifications.deleteMany({ where: { user_id: { in: users } } })
  await db.blocked_users.deleteMany({ where: { OR: [{ blocker_id: { in: users } }, { blocked_id: { in: users } }] } })
  await db.friendships.deleteMany({ where: { OR: [{ user1_id: { in: users } }, { user2_id: { in: users } }] } })
  await db.presence_sessions.deleteMany({ where: { user_id: { in: users } } })
  await db.deleted_account_records.deleteMany({ where: { user_id: { in: users } } }).catch(() => undefined)
  await cleanup(users, world.events)
  await closeDb()
}
