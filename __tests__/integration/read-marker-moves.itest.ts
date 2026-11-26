process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { db } from "./helpers"
import { api, arrive, call, cleanupCrewWorld, liveEvent, person, type Person } from "./crew-world"

/* eslint-disable @typescript-eslint/no-require-imports */
const eventChat = require("@/app/api/mobile/events/[eventId]/chat/route") as typeof import("@/app/api/mobile/events/[eventId]/chat/route")
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Reading a room writes its read marker only when the marker moves (SCRUM-1225). Every newest-page read updated
 * `chat_group_members` even when the marker already pointed at the newest message: a busy room re-fetched on every
 * socket event, so each message became one row write per reader. A first read (marker NULL) must still write it,
 * which is why the guard carries an explicit `null` arm: a bare Prisma `not` excludes NULL.
 */
afterAll(cleanupCrewWorld)

const MIN = 60_000
const T0 = Date.parse("2026-01-01T10:00:00Z")
const at = (minutes: number) => new Date(T0 + minutes * MIN)
// A fixed stamp the marker's row is set to before a read: a write would replace it.
const UNTOUCHED = at(-600)

async function roomWith(label: string) {
  const host = await person(`${label}-host`)
  const viewer = await person(`${label}-v`)
  const other = await person(`${label}-o`)
  const e = await liveEvent(host.id)
  await arrive(e.eventId, e.occurrenceId, viewer, "Otter V")
  await arrive(e.eventId, e.occurrenceId, other, "Heron O")
  const room = await db.chat_groups.findUniqueOrThrow({ where: { event_id: e.eventId }, select: { id: true } })
  return { viewer, other, eventId: e.eventId, roomId: room.id }
}

async function say(roomId: string, userId: string, minute: number) {
  return db.chat_messages.create({ data: { chat_group_id: roomId, user_id: userId, content: `line ${minute}`, created_at: at(minute) } })
}

const markerRow = (roomId: string, userId: string) =>
  db.chat_group_members.findUniqueOrThrow({
    where: { chat_group_id_user_id: { chat_group_id: roomId, user_id: userId } },
    select: { last_read_message_id: true, updated_at: true },
  })

const stampUntouched = (roomId: string, userId: string) =>
  db.chat_group_members.update({ where: { chat_group_id_user_id: { chat_group_id: roomId, user_id: userId } }, data: { updated_at: UNTOUCHED } })

// The two routes that read a room's newest page and write the marker.
const readers: Array<[string, (as: Person, r: { roomId: string; eventId: string }) => Promise<{ status: number }>]> = [
  ["GET /chat/groups/:id/messages", (as, r) => api.read(as, r.roomId)],
  ["GET /events/:id/chat", (as, r) => call(eventChat.GET, `/api/mobile/events/${r.eventId}/chat`, as, { params: { eventId: r.eventId } })],
]

describe.each(readers)("%s writes the read marker only when it moves", (label, read) => {
  const tag = label.includes("groups") ? "rm-g" : "rm-e"

  it("writes it on a first read, when there is no marker yet", async () => {
    const r = await roomWith(`${tag}-1`)
    const newest = await say(r.roomId, r.other.id, 2)
    await say(r.roomId, r.other.id, 1)
    await stampUntouched(r.roomId, r.viewer.id)
    expect((await markerRow(r.roomId, r.viewer.id)).last_read_message_id).toBeNull()

    expect((await read(r.viewer, r)).status).toBe(200)

    const row = await markerRow(r.roomId, r.viewer.id)
    expect(row.last_read_message_id).toBe(newest.id)
    expect(row.updated_at).not.toEqual(UNTOUCHED)
  })

  it("writes nothing on a second read of the same newest page", async () => {
    const r = await roomWith(`${tag}-2`)
    const newest = await say(r.roomId, r.other.id, 1)
    await read(r.viewer, r)
    await stampUntouched(r.roomId, r.viewer.id)

    expect((await read(r.viewer, r)).status).toBe(200)

    expect(await markerRow(r.roomId, r.viewer.id)).toEqual({ last_read_message_id: newest.id, updated_at: UNTOUCHED })
  })

  it("moves it, and clears the chat list's unread count, after a new message", async () => {
    const r = await roomWith(`${tag}-3`)
    await say(r.roomId, r.other.id, 1)
    await read(r.viewer, r)
    const next = await say(r.roomId, r.other.id, 2)
    await stampUntouched(r.roomId, r.viewer.id)
    const before = await api.chatGroups(r.viewer)
    expect(before.body.data.groups.find((g: { id: string }) => g.id === r.roomId).unreadCount).toBe(1)

    expect((await read(r.viewer, r)).status).toBe(200)

    const row = await markerRow(r.roomId, r.viewer.id)
    expect(row.last_read_message_id).toBe(next.id)
    expect(row.updated_at).not.toEqual(UNTOUCHED)
    const after = await api.chatGroups(r.viewer)
    expect(after.body.data.groups.find((g: { id: string }) => g.id === r.roomId).unreadCount).toBe(0)
  })
})
