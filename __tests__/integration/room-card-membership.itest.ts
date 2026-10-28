/*
 * A room card needs a standing seat in the room, for the viewer and the person
 * (SCRUM-864 follow-up). The owner's door (crew membership, the Blend's clock,
 * the post's accepted asks) is not the same as the room's own member row: a
 * member banned from, or gone from, the room still held the handle they had
 * been given and could open a card with it. They now get the stranger's 404.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
process.env.NEXTAUTH_SECRET ??= "itest-room-card-membership-secret-32-chars"
process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"

import { roomHandle } from "@/lib/room-handle"
import { db, makeEvent } from "./helpers"
import { api, arrive, call, cleanupCrewWorld, crewOf, liveEvent, person, world, type Person } from "./crew-world"

/* eslint-disable @typescript-eslint/no-require-imports */
const userRoute = require("@/app/api/mobile/users/[userId]/route") as typeof import("@/app/api/mobile/users/[userId]/route")
const profileRoute = require("@/app/api/mobile/profiles/[userId]/route") as typeof import("@/app/api/mobile/profiles/[userId]/route")
const decide = require("@/app/api/mobile/board/requests/[requestId]/route") as typeof import("@/app/api/mobile/board/requests/[requestId]/route")
/* eslint-enable @typescript-eslint/no-require-imports */

afterAll(async () => {
  const posts = (await db.board_posts.findMany({ where: { event_id: { in: world.events } }, select: { id: true } })).map((p) => p.id)
  const rooms = { chat_group: { board_post_id: { in: posts } } }
  await db.chat_messages.deleteMany({ where: rooms })
  await db.chat_group_members.deleteMany({ where: rooms })
  await db.chat_groups.deleteMany({ where: { board_post_id: { in: posts } } })
  await db.board_requests.deleteMany({ where: { event_id: { in: world.events } } })
  await db.board_posts.deleteMany({ where: { event_id: { in: world.events } } })
  await cleanupCrewWorld()
})

const card = (ref: string, as: Person) => call(userRoute.GET, `/api/mobile/users/${ref}`, as, { params: { userId: ref } })
const full = (ref: string, as: Person) => call(profileRoute.GET, `/api/mobile/profiles/${ref}`, as, { params: { userId: ref } })
const seat = (roomId: string, p: Person, status: "banned" | "left" | "active") =>
  db.chat_group_members.updateMany({ where: { chat_group_id: roomId, user_id: p.id }, data: { status } })

interface World {
  /** A viewer and a target who both hold seats, and the handle that names the target. */
  roomId: string
  viewer: Person
  target: Person
  handle: string
}

async function crewWorld(): Promise<World> {
  const owner = await person("rcm-co", "Olivia Owner Rao")
  const target = await person("rcm-ct", "Devika Target Nair")
  const c = await crewOf(owner, [target])
  return { roomId: c.roomId, viewer: owner, target, handle: roomHandle({ kind: "crew", groupId: c.roomId }, target.id) }
}

async function blendWorld(): Promise<World> {
  const host = await person("rcm-bh")
  const { eventId, occurrenceId } = await liveEvent(host.id)
  const [a1, a2, b1, b2] = await Promise.all(["a1", "a2", "b1", "b2"].map((l) => person(`rcm-${l}`)))
  const A = await crewOf(a1, [a2], "Crew Two")
  const B = await crewOf(b1, [b2], "Crew Five")
  for (const p of [a1, a2, b1, b2]) await arrive(eventId, occurrenceId, p)
  await api.likeCrew(a1, eventId, B.crewId, A.crewId)
  const roomId = (await api.likeCrew(b1, eventId, A.crewId, B.crewId)).body.data.blend.chatGroupId as string
  return { roomId, viewer: a1, target: b1, handle: roomHandle({ kind: "blend", groupId: roomId }, b1.id) }
}

async function boardWorld(): Promise<World> {
  const host = await person("rcm-ph")
  const eventId = await makeEvent(host.id)
  world.events.push(eventId)
  const start = new Date(Date.now() + 86_400_000)
  await db.events.update({ where: { id: eventId }, data: { start_time: start, end_time: new Date(start.getTime() + 3 * 3_600_000) } })
  const [author, a1, a2] = [await person("rcm-au"), await person("rcm-p1"), await person("rcm-p2")]
  const post = await db.board_posts.create({ data: { event_id: eventId, author_id: author.id, kind: "offer", body: "car", spaces_left: 4 }, select: { id: true } })
  for (const asker of [a1, a2]) {
    const r = await db.board_requests.create({ data: { event_id: eventId, post_id: post.id, from_user_id: asker.id, to_user_id: author.id, status: "pending" }, select: { id: true } })
    await call(decide.PATCH, `/api/mobile/board/requests/${r.id}`, author, { method: "PATCH", body: { action: "accept" }, params: { requestId: r.id } })
  }
  const roomId = (await db.chat_groups.findUniqueOrThrow({ where: { board_post_id: post.id }, select: { id: true } })).id
  return { roomId, viewer: a1, target: author, handle: roomHandle({ kind: "board_post", groupId: roomId }, author.id) }
}

describe.each([
  ["crew", crewWorld],
  ["Blend", blendWorld],
  ["board post", boardWorld],
] as const)("a %s's room card", (_kind, build) => {
  it("opens for a viewer and a person who both hold a seat", async () => {
    const w = await build()
    expect((await card(w.handle, w.viewer)).status).toBe(200)
    expect((await full(w.handle, w.viewer)).status).toBe(200)
  })

  it.each(["banned", "left"] as const)("is the stranger's 404 for a viewer who is %s from the room", async (status) => {
    const w = await build()
    await seat(w.roomId, w.viewer, status)
    expect((await card(w.handle, w.viewer)).status).toBe(404)
    expect((await full(w.handle, w.viewer)).status).toBe(404)
  })

  it.each(["banned", "left"] as const)("is the stranger's 404 for a person who is %s from the room", async (status) => {
    const w = await build()
    await seat(w.roomId, w.target, status)
    expect((await card(w.handle, w.viewer)).status).toBe(404)
    expect((await full(w.handle, w.viewer)).status).toBe(404)
  })

  it("is the same body as a stranger gets, so a refusal tells nothing", async () => {
    const w = await build()
    const stranger = await person("rcm-x")
    await seat(w.roomId, w.viewer, "banned")
    expect((await card(w.handle, w.viewer)).body).toEqual((await card(w.handle, stranger)).body)
  })
})
