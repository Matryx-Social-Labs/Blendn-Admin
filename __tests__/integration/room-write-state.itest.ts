/*
 * The room read says whether you may write (SCRUM-809), for every kind of room,
 * and a crew's live messages carry the sender's photo (SCRUM-812): the history
 * and the socket agree, and no other kind of room sends a face.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
process.env.NEXTAUTH_SECRET ??= "itest-room-write-secret-32-characters-xxxxx"
process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"


import { db, makeEvent } from "./helpers"
import { api, arrive, call, cleanupCrewWorld, crewOf, liveEvent, person, socketHarness, until, world, type Person } from "./crew-world"

/* eslint-disable @typescript-eslint/no-require-imports */
const decide = require("@/app/api/mobile/board/requests/[requestId]/route") as typeof import("@/app/api/mobile/board/requests/[requestId]/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const sockets = socketHarness()
beforeAll(() => sockets.start())
afterAll(async () => {
  await sockets.stop()
  const posts = (await db.board_posts.findMany({ where: { event_id: { in: world.events } }, select: { id: true } })).map((p) => p.id)
  const rooms = { chat_group: { board_post_id: { in: posts } } }
  await db.chat_messages.deleteMany({ where: rooms })
  await db.chat_group_members.deleteMany({ where: rooms })
  await db.chat_groups.deleteMany({ where: { board_post_id: { in: posts } } })
  await db.board_requests.deleteMany({ where: { event_id: { in: world.events } } })
  await db.board_posts.deleteMany({ where: { event_id: { in: world.events } } })
  await cleanupCrewWorld()
})

const writeOf = async (as: Person, roomId: string) => {
  const res = await api.read(as, roomId)
  expect(res.status).toBe(200)
  return res.body.data as { status: string; write: { allowed: boolean; reason: string | null; reasonCode: string | null; message: string | null } }
}
const lock = (roomId: string) => db.chat_groups.update({ where: { id: roomId }, data: { status: "locked" } })

/** One open room of each kind and a member who may read it. */
async function rooms() {
  // crew
  const owner = await person("rw-o", "Olivia Owner Rao")
  const m = await person("rw-m")
  const crew = await crewOf(owner, [m])

  // event
  const host = await person("rw-h")
  const { eventId, occurrenceId } = await liveEvent(host.id)
  const e1 = await person("rw-e1")
  await arrive(eventId, occurrenceId, e1)
  const event = await db.chat_groups.findUniqueOrThrow({ where: { event_id: eventId }, select: { id: true } })

  // blend
  const [a1, a2, b1, b2] = await Promise.all(["a1", "a2", "b1", "b2"].map((l) => person(`rw-${l}`)))
  const A = await crewOf(a1, [a2], "Crew Two")
  const B = await crewOf(b1, [b2], "Crew Five")
  for (const p of [a1, a2, b1, b2]) await arrive(eventId, occurrenceId, p)
  await api.likeCrew(a1, eventId, B.crewId, A.crewId)
  const blendRoom = (await api.likeCrew(b1, eventId, A.crewId, B.crewId)).body.data.blend.chatGroupId as string

  // board post
  const bEvent = await makeEvent(host.id)
  world.events.push(bEvent)
  const start = new Date(Date.now() + 86_400_000)
  await db.events.update({ where: { id: bEvent }, data: { start_time: start, end_time: new Date(start.getTime() + 3 * 3_600_000) } })
  const [author, p1, p2] = [await person("rw-au"), await person("rw-p1"), await person("rw-p2")]
  const post = await db.board_posts.create({ data: { event_id: bEvent, author_id: author.id, kind: "offer", body: "car", spaces_left: 4 }, select: { id: true } })
  for (const asker of [p1, p2]) {
    const r = await db.board_requests.create({ data: { event_id: bEvent, post_id: post.id, from_user_id: asker.id, to_user_id: author.id, status: "pending" }, select: { id: true } })
    await call(decide.PATCH, `/api/mobile/board/requests/${r.id}`, author, { method: "PATCH", body: { action: "accept" }, params: { requestId: r.id } })
  }
  const postRoom = (await db.chat_groups.findUniqueOrThrow({ where: { board_post_id: post.id }, select: { id: true } })).id

  return {
    crew: { as: owner, id: crew.roomId, member: m },
    event: { as: e1, id: event.id },
    blend: { as: a1, id: blendRoom },
    board_post: { as: author, id: postRoom },
  }
}

describe("GET /chat/groups/:id/messages: write and status, every kind of room", () => {
  it("is allowed and active in an open room, and locked with its reason once the room is locked", async () => {
    const r = await rooms()
    for (const kind of ["crew", "event", "blend", "board_post"] as const) {
      const open = await writeOf(r[kind].as, r[kind].id)
      expect({ kind, status: open.status, ...open.write }).toEqual({ kind, status: "active", allowed: true, reason: null, reasonCode: null, message: null })
      await lock(r[kind].id)
      const locked = await writeOf(r[kind].as, r[kind].id)
      expect({ kind, status: locked.status, allowed: locked.write.allowed, reason: locked.write.reason, reasonCode: locked.write.reasonCode }).toEqual({
        kind,
        status: "locked",
        allowed: false,
        reason: "locked",
        reasonCode: "locked",
      })
      expect(locked.write.message).toMatch(/locked/i)
    }
  })

  it("names a muted member's mute without a message, in a crew's room", async () => {
    const owner = await person("rw-mo", "Olivia Owner Rao")
    const m = await person("rw-mm")
    const c = await crewOf(owner, [m])
    await db.chat_group_members.updateMany({ where: { chat_group_id: c.roomId, user_id: m.id }, data: { status: "muted", muted_at: new Date(), muted_by: owner.id } })
    const state = await writeOf(m, c.roomId)
    expect(state.write).toEqual({ allowed: false, reason: "muted", reasonCode: "muted", message: null })
  })
})

describe("the socket carries a face for a crew's room only (SCRUM-812)", () => {
  const imageFor = (p: Person) => `https://cdn.itest.invalid/${p.id}.jpg`

  it("sends the sender's photo to a crew, not for a member keeping anonymous, and none in an event's room", async () => {
    const owner = await person("rs-o", "Olivia Owner Rao")
    const [shown, hidden] = [await person("rs-s"), await person("rs-h")]
    for (const p of [owner, shown, hidden]) await db.user.update({ where: { id: p.id }, data: { image: imageFor(p) } })
    const c = await crewOf(owner, [shown, hidden])
    await api.settings(hidden, c.crewId, true)
    const listener = await sockets.online(owner)
    expect(await sockets.joins(listener, c.roomId)).toBe(true)
    await api.send(shown, c.roomId, "from shown")
    await api.send(hidden, c.roomId, "from hidden")
    expect(await until(() => listener.heard.message.length >= 2)).toBe(true)
    const heard = (content: string) => listener.heard.message.find((m) => m.message.content === content)!.message
    expect(heard("from shown").userImage).toBe(imageFor(shown))
    expect(heard("from hidden").userImage).toBeUndefined()

    // An event's room: the same send path, no face.
    const host = await person("rs-h2")
    const { eventId, occurrenceId } = await liveEvent(host.id)
    const [x, y] = [await person("rs-x"), await person("rs-y")]
    for (const p of [x, y]) await db.user.update({ where: { id: p.id }, data: { image: imageFor(p) } })
    await arrive(eventId, occurrenceId, x)
    await arrive(eventId, occurrenceId, y)
    const room = await db.chat_groups.findUniqueOrThrow({ where: { event_id: eventId }, select: { id: true } })
    const eventListener = await sockets.online(y)
    expect(await sockets.joins(eventListener, room.id)).toBe(true)
    expect((await api.send(x, room.id, "from event")).status).toBe(201)
    expect(await until(() => eventListener.heard.message.some((m) => m.message.content === "from event"))).toBe(true)
    expect(eventListener.heard.message.find((m) => m.message.content === "from event")!.message.userImage).toBeUndefined()
  })
})

