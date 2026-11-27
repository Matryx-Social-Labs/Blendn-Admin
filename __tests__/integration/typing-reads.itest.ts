process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { conversationPair } from "@/lib/conversations"
import { emitChatTyping, emitPrivateRead, emitPrivateTyping, TYPING_ROOM_CAP, type AuthenticatedSocket } from "@/lib/socket-server"

import { arrive, cleanupCrewWorld, liveEvent, person, type Person } from "./crew-world"
import { db } from "./helpers"
import { sqlCounter } from "./sql-count"

/**
 * Typing and read receipts (perf/hot-paths #12): the DM gate and the naming
 * read were one conversation read twice, and a room's typing re-read the
 * typist's membership (three statements) on every keystroke burst.
 */
const counter = sqlCounter()
afterAll(async () => {
  await counter.stop()
  await cleanupCrewWorld()
})

/** A socket as the emitters touch it: what it sends, to whom, and which rooms it is in. */
function fakeSocket(me: Person, rooms: string[] = [], roomSize = 2) {
  const sent: { to: string; event: string; payload: unknown }[] = []
  const peer = { id: "sock-peer", data: { userId: "peer" }, emit: (event: string, payload: unknown) => sent.push({ to: "peer", event, payload }) }
  const chatRoom = { except: () => chatRoom, fetchSockets: async () => [peer] }
  // `socket.to(room)` and its `.except(…)` / `.volatile` chain: what reaches `room` is recorded.
  const target = (to: string) => {
    const operator = { emit: (event: string, payload: unknown) => sent.push({ to, event, payload }), except: () => operator, volatile: {} as unknown }
    operator.volatile = operator
    return operator
  }
  const socket = {
    id: "sock-me",
    data: { userId: me.id, email: `${me.id}@itest.invalid`, principal: "mobile" },
    rooms: new Set(rooms),
    // The rooms as the adapter holds them: `roomSize` sockets each (`TYPING_ROOM_CAP`).
    nsp: { in: () => chatRoom, to: target, adapter: { rooms: new Map(rooms.map((r) => [r, new Set(Array.from({ length: roomSize }, (_, i) => `sock-${i}`))])) } },
    to: target,
  }
  return { socket: socket as unknown as AuthenticatedSocket, sent }
}

async function conversation(a: Person, b: Person, closed = false) {
  const [user1_id, user2_id] = conversationPair(a.id, b.id)
  return db.private_conversations.create({ data: { user1_id, user2_id, ...(closed && { closed_at: new Date() }) }, select: { id: true } })
}

describe("a private conversation's typing and read receipts", () => {
  it("a second start at once, and a stop with no start, read nothing and say nothing", async () => {
    const [me, them] = await Promise.all([person("tg-me", "Maya Typer"), person("tg-them")])
    const { id } = await conversation(me, them)
    const s = fakeSocket(me)
    // One statement of our own, so a run that reads nothing still proves the counter is recording.
    const reads = async (run: () => Promise<void>) =>
      (await counter.during(async () => (await globalThis.prisma!.$queryRaw`SELECT 1`, run()))).sql.length - 1
    expect(await reads(() => emitPrivateTyping(s.socket, id, false))).toBe(0)
    expect(await reads(() => emitPrivateTyping(s.socket, id, true))).toBeGreaterThan(0)
    expect(await reads(() => emitPrivateTyping(s.socket, id, true))).toBe(0)
    // A room id that could never be one is keyed like any other: no read for its repeat.
    const inRoom = fakeSocket(me, [`chat:${id}`])
    expect(await reads(() => emitChatTyping(inRoom.socket, id, true))).toBeGreaterThan(0)
    expect(await reads(() => emitChatTyping(inRoom.socket, id, true))).toBe(0)
    // A socket that never joined the room reads nothing at all (SCRUM-1309).
    expect(await reads(() => emitChatTyping(s.socket, id, true))).toBe(0)
    expect(s.sent.map((m) => m.event)).toEqual(["private:typing"])
  })

  it("read the conversation once, and say what they said", async () => {
    const [me, them, stranger] = await Promise.all([person("tr-me", "Maya Typer"), person("tr-them"), person("tr-stranger")])
    const { id } = await conversation(me, them)

    const typing = fakeSocket(me)
    const { sql } = await counter.during(() => emitPrivateTyping(typing.socket, id, true))
    // Before: the gate read the conversation, then the naming read did (3 with the profile).
    expect(sql.filter((q) => /FROM "public"\."private_conversations"/.test(q))).toHaveLength(1)
    expect(typing.sent).toHaveLength(1)
    expect(typing.sent[0]).toMatchObject({ event: "private:typing", payload: { conversationId: id, isTyping: true } })

    const read = fakeSocket(me)
    const { sql: readSql } = await counter.during(() => emitPrivateRead(read.socket, id, ["00000000-0000-4000-8000-000000000001"]))
    expect(readSql.filter((q) => /FROM "public"\."private_conversations"/.test(q))).toHaveLength(1)
    expect(read.sent.map((s) => s.event)).toEqual(["private:read"])

    // The gate is what it was: a stranger, and a closed conversation, are told nothing.
    const outsider = fakeSocket(stranger)
    await emitPrivateTyping(outsider.socket, id, true)
    await emitPrivateRead(outsider.socket, id, ["00000000-0000-4000-8000-000000000001"])
    const closed = await conversation(me, stranger, true)
    const afterClose = fakeSocket(me)
    await emitPrivateTyping(afterClose.socket, closed.id, true)
    await emitPrivateRead(afterClose.socket, closed.id, ["00000000-0000-4000-8000-000000000001"])
    expect([...outsider.sent, ...afterClose.sent]).toEqual([])
  })
})

describe("a room's typing", () => {
  async function room() {
    const host = await person("tr-host")
    const typist = await person("tr-typist")
    const { eventId, occurrenceId } = await liveEvent(host.id)
    await arrive(eventId, occurrenceId, typist, "Otter Typist")
    const group = await db.chat_groups.findUniqueOrThrow({ where: { event_id: eventId }, select: { id: true } })
    return { typist, groupId: group.id, eventId }
  }
  const memberReads = (sql: string[]) => sql.filter((q) => /FROM "public"\."chat_group_members"/.test(q)).length

  it("asks the typist's membership on every burst, so a mute or ban is obeyed at once", async () => {
    const { typist, groupId } = await room()
    const { socket, sent } = fakeSocket(typist, [`chat:${groupId}`])
    const first = await counter.during(() => emitChatTyping(socket, groupId, true))
    expect(memberReads(first.sql)).toBe(1)
    // Muted, still in the socket room (a mute evicts nobody): the next burst says nothing.
    await db.chat_group_members.update({ where: { chat_group_id_user_id: { chat_group_id: groupId, user_id: typist.id } }, data: { status: "muted" } })
    await emitChatTyping(socket, groupId, true)
    expect(sent.map((s) => (s.payload as { userName: string }).userName)).toEqual(["Otter Typist"])
  })

  it("above TYPING_ROOM_CAP sockets, a start runs no statement and says typing:several (SCRUM-1309)", async () => {
    const { typist, groupId } = await room()
    const { socket, sent } = fakeSocket(typist, [`chat:${groupId}`], TYPING_ROOM_CAP + 1)
    const reads = async (run: () => Promise<void>) =>
      (await counter.during(async () => (await globalThis.prisma!.$queryRaw`SELECT 1`, run()))).sql.length - 1
    expect(await reads(() => emitChatTyping(socket, groupId, true))).toBe(0)
    expect(sent).toEqual([{ to: `chat:${groupId}`, event: "typing:several", payload: { chatGroupId: groupId } }])
  })
})
