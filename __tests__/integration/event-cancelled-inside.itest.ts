/*
 * Cancelling an event tells the people inside (SV7).
 *
 * The cascade cancelled their check-ins and emitted nothing. Now: one socket
 * emit to the event's rooms, and one `event_cancelled` push per person who was
 * inside, in batches; somebody inside who was also going hears it once;
 * somebody going who was not inside still gets the `event_update` line; a second
 * run tells nobody.
 *
 * A real socket.io server is the app's `io`; Expo's client is mocked.
 */
type Msg = { to: string; data?: { type?: string } }
const sent = jest.fn(async (msgs: Msg[]) => msgs.map(() => ({ status: "ok", id: "t" })))
jest.mock("expo-server-sdk", () => {
  class Expo {
    static isExpoPushToken(t: string) {
      return t.startsWith("ExponentPushToken[")
    }
    chunkPushNotifications(m: unknown[]) {
      return [m]
    }
    sendPushNotificationsAsync(chunk: Msg[]) {
      return sent(chunk)
    }
  }
  return { Expo }
})

import { createServer } from "http"
import type { AddressInfo } from "net"
import { Server } from "socket.io"
import { io as connect, type Socket as ClientSocket } from "socket.io-client"

import { cancelEventCheckIns } from "@/lib/event-cancellation"
import { notifyEventCancelled } from "@/lib/services/event-notifications.service"
import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, putInRoom, testId } from "./helpers"

const users: string[] = []
const events: string[] = []
const httpServer = createServer()
const io = new Server(httpServer)
const clients: ClientSocket[] = []

beforeAll(async () => {
  await new Promise<void>((resolve) => httpServer.listen(0, resolve))
  ;(globalThis as { __blendnSocketIo?: unknown }).__blendnSocketIo = io
  io.on("connection", (socket) => {
    socket.on("join", (room: string) => void socket.join(room))
  })
})

afterAll(async () => {
  clients.forEach((c) => c.close())
  ;(globalThis as { __blendnSocketIo?: unknown }).__blendnSocketIo = null
  await new Promise((resolve) => io.close(resolve))
  await db.notifications.deleteMany({ where: { user_id: { in: users } } })
  await db.push_tokens.deleteMany({ where: { user_id: { in: users } } })
  await db.presence_sessions.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
})

beforeEach(() => sent.mockClear())

async function phoneIn(room: string) {
  const { port } = httpServer.address() as AddressInfo
  const socket = connect(`http://localhost:${port}`, { transports: ["websocket"], reconnection: false })
  clients.push(socket)
  const heard: Array<{ event: string; payload: unknown }> = []
  socket.onAny((event: string, payload: unknown) => heard.push({ event, payload }))
  await new Promise<void>((resolve) => socket.on("connect", () => resolve()))
  socket.emit("join", room)
  await new Promise((r) => setTimeout(r, 100))
  return heard
}

async function person(label: string, withToken = true) {
  const id = await makeUser(testId(label))
  users.push(id)
  if (withToken) await db.push_tokens.create({ data: { user_id: id, token: `ExponentPushToken[itest-${id}]`, platform: "ios", channel_set: 2 } })
  return id
}

async function room() {
  const host = await makeUser(testId("ci-host"), "organizer")
  users.push(host)
  const eventId = await makeEvent(host)
  events.push(eventId)
  return { eventId, occurrenceId: await occurrenceOf(eventId) }
}

const typesSent = () => sent.mock.calls.flatMap((c) => c[0].map((m) => `${m.data?.type}:${m.to}`))

it("tells those inside once: one emit to the room, an event_cancelled push each, and a bell row", async () => {
  const r = await room()
  const insideA = await person("ci-a")
  const insideGoing = await person("ci-going")
  const goingOnly = await person("ci-goingonly")
  const outside = await person("ci-outside")
  await putInRoom({ ...r, userId: insideA })
  await putInRoom({ ...r, userId: insideGoing })
  await db.event_rsvps.createMany({
    data: [insideGoing, goingOnly].map((user_id) => ({ event_id: r.eventId, user_id, status: "going" as const })),
  })
  const inRoom = await phoneIn(`event:room:${r.eventId}`)
  const inEvent = await phoneIn(`event:${r.eventId}`)
  const elsewhere = await phoneIn("event:someone-else")

  const { count, inside } = await cancelEventCheckIns(r.eventId)
  await notifyEventCancelled(r.eventId, "t", inside)
  await new Promise((resolve) => setTimeout(resolve, 100))

  expect(count).toBe(2)
  expect(inRoom.filter((h) => h.event === "event:cancelled")).toEqual([{ event: "event:cancelled", payload: { eventId: r.eventId } }])
  expect(inEvent.filter((h) => h.event === "event:cancelled")).toHaveLength(1)
  expect(elsewhere.filter((h) => h.event === "event:cancelled")).toHaveLength(0)

  const sentTo = typesSent()
  expect(sentTo.sort()).toEqual(
    [
      `event_cancelled:ExponentPushToken[itest-${insideA}]`,
      `event_cancelled:ExponentPushToken[itest-${insideGoing}]`,
      `event_changed:ExponentPushToken[itest-${goingOnly}]`,
    ].sort()
  )
  expect(sentTo.join()).not.toContain(outside)

  const bell = await db.notifications.findMany({ where: { user_id: { in: [insideA, insideGoing, goingOnly] } }, select: { user_id: true, kind: true } })
  expect(bell.filter((b) => b.user_id === insideGoing).map((b) => b.kind)).toEqual(["event_cancelled"])
  expect(bell.filter((b) => b.user_id === goingOnly).map((b) => b.kind)).toEqual(["event_changed"])
})

it("a second run over the cancelled event tells nobody again", async () => {
  const r = await room()
  const who = await person("ci-once")
  await putInRoom({ ...r, userId: who })
  expect((await cancelEventCheckIns(r.eventId)).inside).toEqual([who])
  sent.mockClear()
  const again = await cancelEventCheckIns(r.eventId)
  expect(again).toEqual({ count: 0, inside: [] })
  expect(sent).not.toHaveBeenCalled()
})

it("an event nobody is inside emits and sends nothing", async () => {
  const r = await room()
  const heard = await phoneIn(`event:${r.eventId}`)
  await cancelEventCheckIns(r.eventId)
  expect(sent).not.toHaveBeenCalled()
  expect(heard.filter((h) => h.event === "event:cancelled")).toHaveLength(0)
})

it("a room bigger than a page is read in pages and pushed in batches", async () => {
  const r = await room()
  const total = 1250 // past one page of 1000
  const ids = Array.from({ length: total }, (_, i) => testId(`ci-big${i}`))
  await db.user.createMany({ data: ids.map((id) => ({ id, email: `${id}@itest.invalid`, name: "Big", role: "attendee" as const })) })
  users.push(...ids)
  await db.push_tokens.createMany({ data: ids.map((id) => ({ user_id: id, token: `ExponentPushToken[itest-${id}]`, platform: "ios", channel_set: 2 })) })
  await db.event_check_ins.createMany({
    data: ids.map((user_id) => ({
      event_id: r.eventId,
      occurrence_id: r.occurrenceId,
      user_id,
      status: "checked_in" as const,
      check_in_time: new Date(),
      last_seen_at: new Date(),
    })),
  })

  const { count, inside } = await cancelEventCheckIns(r.eventId)

  expect(count).toBe(total)
  expect(new Set(inside).size).toBe(total)
  const cancelledPushes = typesSent().filter((t) => t.startsWith("event_cancelled:"))
  expect(cancelledPushes).toHaveLength(total)
  // Batches, not one send of everybody: each call to the sender is at most 500 people.
  expect(Math.max(...sent.mock.calls.map((c) => c[0].length))).toBeLessThanOrEqual(500)
  expect(sent.mock.calls.length).toBeGreaterThanOrEqual(Math.ceil(total / 500))
}, 60_000)

it("a build that predates the kind is sent event_update, which it opens on the event", async () => {
  const r = await room()
  const old = await person("ci-oldbuild")
  await db.push_tokens.updateMany({ where: { user_id: old }, data: { channel_set: 1 } })
  await putInRoom({ ...r, userId: old })
  await cancelEventCheckIns(r.eventId)
  expect(typesSent()).toEqual([`event_update:ExponentPushToken[itest-${old}]`])
})
