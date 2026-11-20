process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { db, testId } from "./helpers"
import { api, cleanupCrewWorld, liveEvent, person, world, type Person } from "./crew-world"
import { sqlCounter } from "./sql-count"

/**
 * Lobby (board post) rooms in the Banter (Flow 5 C5 · B-A "Rooms · Your ride"): `GET /chat/groups` lists every board
 * post room the viewer is seated in, as its door admits them now (`roomReadDenialFor`), in `rooms` beside the crews'
 * and Blends'. The row says the post's kind, who else is in it by their room pseudonyms (three at most, and a count),
 * unread, the last line and the mute; a room that is over or no longer theirs is not listed.
 */
const counter = sqlCounter()
afterAll(async () => {
  await counter.stop()
  await cleanupCrewWorld()
})

const HOUR = 3_600_000

interface Seated {
  postId: string
  roomId: string
}

/** A ride offer with its room, the author and every asker seated under their pseudonyms -- what an accept writes. */
async function rideRoom(eventId: string, author: Person, askers: [Person, string][], authorName = "Amber Lynx"): Promise<Seated> {
  const post = await db.board_posts.create({
    data: { event_id: eventId, author_id: author.id, kind: "offer", sub_kind: "ride", body: "Car from Indiranagar at 5:30", spaces_left: 4 },
    select: { id: true },
  })
  for (const [asker] of askers) {
    await db.board_requests.create({
      data: { event_id: eventId, post_id: post.id, from_user_id: asker.id, to_user_id: author.id, status: "accepted", decided_at: new Date() },
    })
  }
  const room = await db.chat_groups.create({
    data: { kind: "board_post", board_post_id: post.id, name: "Car from Indiranagar at 5:30", status: "active" },
    select: { id: true },
  })
  await db.chat_group_members.createMany({
    data: [
      { chat_group_id: room.id, user_id: author.id, anonymous_name: authorName },
      ...askers.map(([p, name]) => ({ chat_group_id: room.id, user_id: p.id, anonymous_name: name })),
    ],
  })
  return { postId: post.id, roomId: room.id }
}

type Row = { id: string; kind: string; [k: string]: unknown }
const roomsOf = async (p: Person): Promise<Row[]> => {
  const res = await api.chatGroups(p)
  expect(res.status).toBe(200)
  return res.body.data.rooms
}
const lobbyRow = async (p: Person, roomId: string) => (await roomsOf(p)).find((r) => r.id === roomId)

describe("Lobby rooms in the chat list", () => {
  it("lists the room with the post's kind, the others by room pseudonym, unread and the last line", async () => {
    const { eventId } = await liveEvent((await person("lr-host")).id)
    const [author, v, a] = await Promise.all([person("lr-author"), person("lr-v", "Vee Viewer Rao"), person("lr-a")])
    const { postId, roomId } = await rideRoom(eventId, author, [[v, "Lunar Fox"], [a, "Velvet Owl"]])
    await db.chat_messages.create({ data: { chat_group_id: roomId, user_id: a.id, content: "Leaving in 10" } })

    const row = await lobbyRow(v, roomId)
    expect(row).toMatchObject({
      kind: "board_post",
      name: "Car from Indiranagar at 5:30",
      boardPost: { id: postId, eventId, kind: "offer", subKind: "ride", yours: false },
      others: { names: ["Amber Lynx", "Velvet Owl"], count: 2 },
      unreadCount: 1,
      lastMessage: { content: "Leaving in 10", user: { name: "Velvet Owl" } },
      mute: expect.anything(),
      membership: { status: "active" },
    })
    // A handle, never the account id; the viewer's own pseudonym is not among the others.
    expect(JSON.stringify(row)).not.toContain(a.id)
    expect(JSON.stringify(row)).not.toContain(author.id)
    expect(JSON.stringify(row)).not.toContain("Lunar Fox")
    expect(typeof row!.closesAt).toBe("string")

    // The author's own ride.
    expect((await lobbyRow(author, roomId))?.boardPost).toMatchObject({ yours: true })

    // Muted: still listed, saying so (a mute silences, it does not banish); banned: gone.
    await db.chat_group_members.update({
      where: { chat_group_id_user_id: { chat_group_id: roomId, user_id: v.id } },
      data: { status: "muted", notification_preferences: { muted: true, muted_until: null } },
    })
    expect(await lobbyRow(v, roomId)).toMatchObject({ membership: { status: "muted" }, mute: { muted: true } })
    await db.chat_group_members.update({ where: { chat_group_id_user_id: { chat_group_id: roomId, user_id: a.id } }, data: { status: "banned" } })
    expect((await lobbyRow(v, roomId))?.others).toEqual({ names: ["Amber Lynx"], count: 1 })
    expect(await lobbyRow(a, roomId)).toBeUndefined()
  })

  it("names three others at most and counts them all, never a blocked one", async () => {
    const { eventId } = await liveEvent((await person("lr3-host")).id)
    const author = await person("lr3-author")
    const v = await person("lr3-v")
    const others = await Promise.all([1, 2, 3, 4, 5].map((i) => person(`lr3-${i}`)))
    const names = ["Amber Lynx", "Coral Heron", "Dusky Wren", "Ember Stoat", "Frost Otter", "Gilded Moth"]
    const { roomId } = await rideRoom(eventId, author, [[v, "Lunar Fox"], ...others.map((p, i): [Person, string] => [p, names[i + 1]])], names[0])
    await db.blocked_users.create({ data: { blocker_id: v.id, blocked_id: others[0].id } })
    // Still a member row, no longer admitted by the post (their ask withdrawn): not one of the others.
    await db.board_requests.updateMany({ where: { from_user_id: others[4].id }, data: { status: "withdrawn" } })

    const row = await lobbyRow(v, roomId)
    expect(row?.others).toEqual({ names: ["Amber Lynx", "Dusky Wren", "Ember Stoat"], count: 4 })
    expect(JSON.stringify(row)).not.toContain("Coral Heron")
  })

  it("leaves out a room that is over or no longer theirs", async () => {
    const host = await person("lrx-host")
    const { eventId } = await liveEvent(host.id)
    const [author, v] = await Promise.all([person("lrx-author"), person("lrx-v")])
    const withdrawn = await rideRoom(eventId, author, [[v, "Lunar Fox"]])
    const archived = await rideRoom(eventId, author, [[v, "Lunar Fox"]])
    const left = await rideRoom(eventId, author, [[v, "Lunar Fox"]])
    const unaccepted = await rideRoom(eventId, author, [[v, "Lunar Fox"]])
    const open = await rideRoom(eventId, author, [[v, "Lunar Fox"]])
    await db.board_posts.update({ where: { id: withdrawn.postId }, data: { deleted_at: new Date() } })
    await db.chat_groups.update({ where: { id: archived.roomId }, data: { status: "archived" } })
    await db.chat_group_members.update({
      where: { chat_group_id_user_id: { chat_group_id: left.roomId, user_id: v.id } },
      data: { status: "left", left_at: new Date() },
    })
    await db.board_requests.updateMany({ where: { post_id: unaccepted.postId, from_user_id: v.id }, data: { status: "withdrawn" } })

    const ids = (await roomsOf(v)).map((r) => r.id)
    // The control: the same room, untouched, is listed.
    expect(ids).toContain(open.roomId)
    for (const gone of [withdrawn, archived, left, unaccepted]) expect(ids).not.toContain(gone.roomId)

    // Its event's room closed (a day after the end): the ride's room is over too (SCRUM-1026).
    const past = await liveEvent(host.id)
    world.events.push(past.eventId)
    await db.events.update({ where: { id: past.eventId }, data: { start_time: new Date(Date.now() - 40 * HOUR), end_time: new Date(Date.now() - 30 * HOUR) } })
    const over = await rideRoom(past.eventId, author, [[v, "Lunar Fox"]])
    expect((await roomsOf(v)).map((r) => r.id)).not.toContain(over.roomId)
  })

  it("reads the rooms' others in one statement, not one per room", async () => {
    const { eventId } = await liveEvent((await person("lrn-host")).id)
    const [author, v] = await Promise.all([person("lrn-author"), person("lrn-v")])
    await rideRoom(eventId, author, [[v, "Lunar Fox"]])
    await api.chatGroups(v)
    const { sql: few } = await counter.during(() => api.chatGroups(v))
    for (let i = 0; i < 4; i++) await rideRoom(eventId, author, [[v, testId("Fox").slice(0, 20)]])
    const { result, sql: many } = await counter.during(() => api.chatGroups(v))
    expect(result.body.data.rooms.filter((r: Row) => r.kind === "board_post").length).toBe(5)
    expect(many.length).toBe(few.length)
  })
})
