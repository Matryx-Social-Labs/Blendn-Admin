/*
 * One person, one page -- on every surface that opens a person (the 2026-10-27
 * fix round, O3). A friend opened from a DM header was "Attendee" with no
 * photos while the same person opened from Me -> Friends was named (SCRUM-863),
 * and a name tapped in a crew, Blend or board-post chat opened "profile not
 * available" for somebody whose first name was on the bubble (SCRUM-864).
 *
 * Real routes, real rows. The room surfaces keep their rule: an event room's
 * handle is still the pseudonym card for a friend who did not opt in.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
process.env.NEXTAUTH_SECRET ??= "itest-identity-surfaces-secret-32-characters"
process.env.MOBILE_JWT_SECRET ??= "itest-mobile-secret-0123456789abcdefghij"

import { NextRequest } from "next/server"

import { roomHandle } from "@/lib/room-handle"
import { db, makeEvent, testId } from "./helpers"
import { api, arrive, befriend, call, cleanupCrewWorld, crewOf, liveEvent, person, world, type Person } from "./crew-world"

/* eslint-disable @typescript-eslint/no-require-imports */
const userRoute = require("@/app/api/mobile/users/[userId]/route") as typeof import("@/app/api/mobile/users/[userId]/route")
const profileRoute = require("@/app/api/mobile/profiles/[userId]/route") as typeof import("@/app/api/mobile/profiles/[userId]/route")
const friendRoute = require("@/app/api/mobile/friends/[userId]/route") as typeof import("@/app/api/mobile/friends/[userId]/route")
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

const user = (ref: string, as: Person) => call(userRoute.GET, `/api/mobile/users/${ref}`, as, { params: { userId: ref } })
const profile = (ref: string, as: Person) => call(profileRoute.GET, `/api/mobile/profiles/${ref}`, as, { params: { userId: ref } })
const friend = (ref: string, as: Person) => call(friendRoute.GET, `/api/mobile/friends/${ref}`, as, { params: { userId: ref } })

describe("a friend, opened by their real id (SCRUM-863)", () => {
  async function pair(label: string) {
    const a = await person(`${label}-a`, "Ayesha Alpha Khan")
    const b = await person(`${label}-b`, "Bharat Beta Menon")
    await befriend(a, b)
    await db.profiles.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { friends_see_me_in_rooms: false } })
    await db.user.update({ where: { id: b.id }, data: { name: "Bharat Beta Menon" } })
    await db.profiles.update({ where: { id: b.id }, data: { bio: "Plays the tabla", photos: ["https://cdn.itest.invalid/b.jpg"] } })
    return { a, b }
  }

  it("names the friend on /users and /profiles exactly as /friends does, with the room switch off", async () => {
    const { a, b } = await pair("fr")
    expect((await friend(b.id, a)).body.data.name).toBe("Bharat Beta Menon")
    const card = await user(b.id, a)
    expect(card.status).toBe(200)
    expect(card.body.data).toMatchObject({ name: "Bharat Beta Menon", identityVisible: true, bio: "Plays the tabla" })
    expect(card.body.data.photos).toEqual(["https://cdn.itest.invalid/b.jpg"])
    const full = await profile(b.id, a)
    expect(full.body.data).toMatchObject({ name: "Bharat Beta Menon" })
    expect(full.body.data.profile.bio).toBe("Plays the tabla")
  })

  it("leaves an event room's handle for that friend as the pseudonym card: the room rule is unchanged", async () => {
    const { a, b } = await pair("frr")
    const host = await person("frr-host")
    const { eventId, occurrenceId } = await liveEvent(host.id)
    const pseudonym = await arrive(eventId, occurrenceId, b)
    await arrive(eventId, occurrenceId, a)
    const card = await user(roomHandle(eventId, b.id), a)
    expect(card.status).toBe(200)
    expect(card.body.data).toMatchObject({ name: pseudonym, identityVisible: false })
    expect(card.body.data.photos).toBeUndefined()
    expect(card.body.data.bio).toBeUndefined()
  })

  it("is still a stranger's card for somebody who is not a friend", async () => {
    const { a } = await pair("frs")
    const stranger = await person("frs-s", "Chitra Gamma Iyer")
    const card = await user(stranger.id, a)
    expect(card.body.data).toMatchObject({ name: "Attendee", identityVisible: false })
    expect(card.body.data.photos).toBeUndefined()
  })

  it("is nobody once either side blocks, on every surface", async () => {
    for (const blocker of ["a", "b"] as const) {
      const { a, b } = await pair(`frb${blocker}`)
      await db.blocked_users.create({
        data: { blocker_id: blocker === "a" ? a.id : b.id, blocked_id: blocker === "a" ? b.id : a.id },
      })
      expect((await friend(b.id, a)).status).toBe(404)
      expect((await user(b.id, a)).status).toBe(404)
      expect((await profile(b.id, a)).status).toBe(404)
      expect((await user(a.id, b)).status).toBe(404)
    }
  })

  it("is nobody once they have unfriended", async () => {
    const { a, b } = await pair("fru")
    await db.friendships.deleteMany({ where: { OR: [{ user1_id: a.id }, { user2_id: a.id }] } })
    expect((await user(b.id, a)).body.data).toMatchObject({ name: "Attendee", identityVisible: false })
  })
})

describe("a crew's handle (SCRUM-864)", () => {
  async function crew(label: string) {
    const owner = await person(`${label}-o`, "Asha Owner Rao")
    const m1 = await person(`${label}-m1`, "Devika Member Nair")
    const m2 = await person(`${label}-m2`, "Eshan Member Pillai")
    const c = await crewOf(owner, [m1, m2])
    const handle = (whom: Person) => roomHandle({ kind: "crew", groupId: c.roomId }, whom.id)
    return { owner, m1, m2, c, handle }
  }

  it("opens as the room card with the first name only, for a member looking at a member", async () => {
    const w = await crew("cr")
    const res = await user(w.handle(w.m1), w.owner)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ id: w.handle(w.m1), name: "Devika", identityVisible: false, isOwnProfile: false })
    expect(JSON.stringify(res.body)).not.toMatch(/Nair|Member/)
    for (const k of ["photos", "image", "bio", "occupation", "interests", "blurPhoto"]) expect(res.body.data[k]).toBeUndefined()
    const full = await profile(w.handle(w.m1), w.owner)
    expect(full.status).toBe(200)
    expect(full.body.data).toMatchObject({ id: w.handle(w.m1), name: "Devika" })
    expect(JSON.stringify(full.body)).not.toMatch(/Nair|@itest/)
  })

  it("is nobody to a person the crew's door does not admit", async () => {
    const w = await crew("cro")
    const outsider = await person("cro-x")
    expect((await user(w.handle(w.m1), outsider)).status).toBe(404)
    expect((await profile(w.handle(w.m1), outsider)).status).toBe(404)
  })

  it("is nobody once the member left, or a block lies between", async () => {
    const w = await crew("crl")
    expect((await user(w.handle(w.m2), w.owner)).status).toBe(200)
    await db.blocked_users.create({ data: { blocker_id: w.owner.id, blocked_id: w.m2.id } })
    expect((await user(w.handle(w.m2), w.owner)).status).toBe(404)
    expect((await profile(w.handle(w.m2), w.owner)).status).toBe(404)
    await db.blocked_users.deleteMany({ where: { blocker_id: w.owner.id } })
    expect((await api.remove(w.m2, w.c.crewId, w.m2.id)).status).toBe(200)
    expect((await user(w.handle(w.m2), w.owner)).status).toBe(404)
  })

  it("is not minted from a forged handle", async () => {
    const w = await crew("crf")
    const handle = w.handle(w.m1)
    expect((await user(`${handle.slice(0, -3)}AAA`, w.owner)).status).toBe(404)
  })
})

describe("a Blend's handle (SCRUM-864)", () => {
  it("opens as tonight's pseudonym for the people in it, and as nobody for anyone else", async () => {
    const host = await person("bl-host")
    const { eventId, occurrenceId } = await liveEvent(host.id)
    const [a1, a2] = await Promise.all([person("bl-a1", "Ananya One Bhat"), person("bl-a2", "Anil Two Bhat")])
    const [b1, b2] = await Promise.all([person("bl-b1", "Vikram One Shetty"), person("bl-b2", "Vani Two Shetty")])
    const A = await crewOf(a1, [a2], "Crew Two")
    const B = await crewOf(b1, [b2], "Crew Five")
    const names = new Map<string, string>()
    for (const p of [a1, a2, b1, b2]) names.set(p.id, await arrive(eventId, occurrenceId, p))
    await api.likeCrew(a1, eventId, B.crewId, A.crewId)
    const back = await api.likeCrew(b1, eventId, A.crewId, B.crewId)
    const roomId = back.body.data.blend.chatGroupId as string
    const handle = (whom: Person) => roomHandle({ kind: "blend", groupId: roomId }, whom.id)

    const res = await user(handle(b1), a1)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ name: names.get(b1.id), identityVisible: false })
    expect(JSON.stringify(res.body)).not.toMatch(/Vikram|Shetty/)
    expect((await profile(handle(a2), b2)).body.data.name).toBe(names.get(a2.id))

    const outsider = await person("bl-x")
    expect((await user(handle(b1), outsider)).status).toBe(404)
  })
})

describe("a board post's handle (SCRUM-864)", () => {
  it("opens as the pseudonym that room gave them, for the people in it only", async () => {
    const host = await person("bp-host")
    const eventId = await makeEvent(host.id)
    world.events.push(eventId)
    const start = new Date(Date.now() + 24 * 3600_000)
    await db.events.update({ where: { id: eventId }, data: { start_time: start, end_time: new Date(start.getTime() + 3 * 3600_000) } })
    const [author, a1, a2] = await Promise.all([person("bp-au", "Farah Author Dsouza"), person("bp-a1"), person("bp-a2")])
    const post = await db.board_posts.create({
      data: { event_id: eventId, author_id: author.id, kind: "offer", body: `Car ${testId("p")}`, spaces_left: 4 },
      select: { id: true },
    })
    for (const asker of [a1, a2]) {
      const request = await db.board_requests.create({
        data: { event_id: eventId, post_id: post.id, from_user_id: asker.id, to_user_id: author.id, status: "pending" },
        select: { id: true },
      })
      const res = await decide.PATCH(
        new NextRequest(`http://localhost/api/mobile/board/requests/${request.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json", authorization: `Bearer ${author.token}` },
          body: JSON.stringify({ action: "accept" }),
        }),
        { params: Promise.resolve({ requestId: request.id }) }
      )
      expect(res.status).toBe(200)
    }
    const room = await db.chat_groups.findUniqueOrThrow({
      where: { board_post_id: post.id },
      select: { id: true, members: { select: { user_id: true, anonymous_name: true } } },
    })
    const nameOf = (p: Person) => room.members.find((m) => m.user_id === p.id)!.anonymous_name
    const handle = (whom: Person) => roomHandle({ kind: "board_post", groupId: room.id }, whom.id)

    const res = await user(handle(author), a1)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ name: nameOf(author), identityVisible: false })
    expect(JSON.stringify(res.body)).not.toMatch(/Farah|Dsouza/)
    expect((await user(handle(author), await person("bp-x"))).status).toBe(404)
  })
})
