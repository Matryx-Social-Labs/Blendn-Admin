process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { db } from "./helpers"
import { api, arrive, cleanupCrewWorld, liveEvent, person } from "./crew-world"

/**
 * An advert is never the line under a room in the chat list (SCRUM-625).
 *
 * The scheduler writes a sponsored send as `text`, `image` or `video` with
 * `metadata.sponsored_message_id`, or as a `poll` whose `metadata.kind` is
 * `sponsored`, so the last-message lookup took it for a person's line. The row
 * must fall back to the newest line that is not one, and say nothing for a room
 * that has only adverts.
 */
afterAll(cleanupCrewWorld)

const MIN = 60_000
const T0 = Date.parse("2026-01-01T10:00:00Z")
const at = (minutes: number) => new Date(T0 + minutes * MIN)

const SPONSORED_SENDS = [
  { label: "a text send", type: "text", metadata: { sponsored_message_id: "11111111-1111-4111-8111-111111111111" } },
  { label: "an image send", type: "image", metadata: { sponsored_message_id: "11111111-1111-4111-8111-111111111111" } },
  { label: "a sponsored poll", type: "poll", metadata: { kind: "sponsored" } },
  { label: "the sponsored kind", type: "sponsored", metadata: {} },
] as const

async function roomWith(label: string) {
  const host = await person(`${label}-host`)
  const viewer = await person(`${label}-v`)
  const a = await person(`${label}-a`)
  const e = await liveEvent(host.id)
  await arrive(e.eventId, e.occurrenceId, viewer, "Otter V")
  await arrive(e.eventId, e.occurrenceId, a, "Heron A")
  const room = await db.chat_groups.findUniqueOrThrow({ where: { event_id: e.eventId }, select: { id: true } })
  return { host, viewer, a, roomId: room.id }
}

describe("the chat list's last-message preview", () => {
  it.each(SPONSORED_SENDS)("skips $label and shows the newest person's line", async ({ type, metadata }) => {
    const { host, viewer, a, roomId } = await roomWith(`cs-${type}`)
    await db.chat_messages.create({ data: { chat_group_id: roomId, user_id: a.id, content: "see you at eight", created_at: at(1) } })
    await db.chat_messages.create({
      data: { chat_group_id: roomId, user_id: host.id, type, metadata, content: "📣 [Sponsored]\nTry the new brew", created_at: at(2) },
    })

    const res = await api.chatGroups(viewer)

    expect(res.status).toBe(200)
    expect(res.body.data.groups[0].lastMessage).toMatchObject({ content: "see you at eight", type: "text" })
  })

  it("has no preview for a room that holds only an advert", async () => {
    const { host, viewer, roomId } = await roomWith("cs-only")
    await db.chat_messages.create({
      data: { chat_group_id: roomId, user_id: host.id, content: "📣 [Sponsored]\nTry the new brew", metadata: { sponsored_message_id: "22222222-2222-4222-8222-222222222222" }, created_at: at(1) },
    })

    const res = await api.chatGroups(viewer)

    expect(res.body.data.groups[0].lastMessage).toBeNull()
  })

  it.each([
    { label: "a poll", metadata: { poll: true, kind: "announcement" } },
    { label: "a poll with no kind", metadata: { poll: true } },
    { label: "a poll with no metadata", metadata: undefined },
  ])("previews $label, which is not an advert", async ({ metadata }) => {
    const { host, viewer, roomId } = await roomWith("cs-poll")
    await db.chat_messages.create({
      data: { chat_group_id: roomId, user_id: host.id, type: "poll", content: "Which set first?", ...(metadata ? { metadata } : {}), created_at: at(1) },
    })

    const res = await api.chatGroups(viewer)

    expect(res.body.data.groups[0].lastMessage).toMatchObject({ type: "poll", content: "Which set first?" })
  })

  it("skips an advert that is older than the person's line without losing the line", async () => {
    const { host, viewer, a, roomId } = await roomWith("cs-old")
    await db.chat_messages.create({
      data: { chat_group_id: roomId, user_id: host.id, content: "📣 [Sponsored]\nTry the new brew", metadata: { sponsored_message_id: "33333333-3333-4333-8333-333333333333" }, created_at: at(1) },
    })
    await db.chat_messages.create({ data: { chat_group_id: roomId, user_id: a.id, content: "newest line", created_at: at(2) } })

    const res = await api.chatGroups(viewer)

    expect(res.body.data.groups[0].lastMessage).toMatchObject({ content: "newest line" })
  })

  it("still previews an announcement, which is the room's own voice", async () => {
    const { host, viewer, roomId } = await roomWith("cs-ann")
    await db.chat_messages.create({
      data: { chat_group_id: roomId, user_id: host.id, type: "announcement", content: "📢 [Announcement from Toit]\nDoors at 8", created_at: at(1) },
    })

    const res = await api.chatGroups(viewer)

    expect(res.body.data.groups[0].lastMessage).toMatchObject({ type: "announcement", content: "📢 [Announcement from Toit]\nDoors at 8" })
  })
})
