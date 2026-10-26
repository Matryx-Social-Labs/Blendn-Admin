import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"
process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET ?? "itest-nextauth-secret-0123456789abcdefghij"
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"
import { applySuspension, liftSuspension } from "@/lib/suspension"
import { roomHandle } from "@/lib/room-handle"

import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, onboard, testId } from "./helpers"

/**
 * A member a host banned from an event's room is out of the room's people, on
 * every route that reads or writes them — not only its chat (security review,
 * SV6). Each answers as the chat does: 403 `USER_BANNED`, "The organiser has
 * removed you from this room." A banned member is not in the room to anybody
 * waving or liking either, and that answer never says why.
 */

/* eslint-disable @typescript-eslint/no-require-imports */
type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>
const route = (path: string) => require(`@/app/api/mobile/${path}/route`) as Record<string, Handler>
const R = {
  roster: route("events/[eventId]/checkins"),
  waves: route("events/[eventId]/waves"),
  likes: route("events/[eventId]/matches/likes"),
  preferences: route("events/[eventId]/matches/preferences"),
  crews: route("events/[eventId]/crews"),
  peerRatings: route("events/[eventId]/peer-ratings"),
  matches: route("events/[eventId]/matches"),
  people: route("events/[eventId]/people"),
  user: route("users/[userId]"),
  profile: route("profiles/[userId]"),
  interests: route("profiles/[userId]/interests"),
  messageRequests: route("message-requests"),
}
/* eslint-enable @typescript-eslint/no-require-imports */

const users: string[] = []
const events: string[] = []

afterAll(async () => {
  await db.event_likes.deleteMany({ where: { event_id: { in: events } } })
  await db.event_occurrences.deleteMany({ where: { event_id: { in: events } } })
  await cleanup(users, events)
  await closeDb()
})

async function person() {
  const id = await makeUser(testId("bm"))
  users.push(id)
  await onboard(id)
  await db.profiles.update({ where: { id }, data: { date_of_birth: new Date("1995-01-01") } })
  return { id, token: signAccessToken(id, `${id}@itest.invalid`) }
}

/** A live room: `banned` checked in and banned by a host, `here` checked in and in good standing. */
async function room() {
  const host = await makeUser(testId("bm_host"), "organizer")
  users.push(host)
  const eventId = await makeEvent(host)
  events.push(eventId)
  const occurrenceId = await occurrenceOf(eventId)
  const group = await db.chat_groups.create({ data: { event_id: eventId, name: "room", status: "active", member_count: 0 } })
  const banned = await person()
  const here = await person()
  for (const [p, status] of [[banned, "banned"], [here, "active"]] as const) {
    await db.event_check_ins.create({ data: { event_id: eventId, occurrence_id: occurrenceId, user_id: p.id, status: "checked_in", check_in_time: new Date() } })
    await db.chat_group_members.create({
      data: { chat_group_id: group.id, user_id: p.id, anonymous_name: testId("Otter"), status, ...(status === "banned" && { banned_by: host }) },
    })
  }
  return { eventId, groupId: group.id, banned, here }
}

const call = async (handler: Handler, path: string, token: string, params: Record<string, string>, method = "GET", body?: unknown) => {
  const res = await handler(
    new NextRequest(`http://localhost/api/mobile/${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve(params) }
  )
  return { status: res.status, json: await res.json() }
}

const REFUSED = { success: false, error: "The organizer has removed you from this room.", errorCode: "USER_BANNED" }

let w: Awaited<ReturnType<typeof room>>
beforeAll(async () => {
  w = await room()
})

describe("a member the room banned is refused the room's people, as the chat refuses them", () => {
  const ev = () => ({ eventId: w.eventId })
  const handleOf = (p: { id: string }) => roomHandle(w.eventId, p.id)

  it.each([
    ["the roster", () => call(R.roster.GET, `events/${w.eventId}/checkins`, w.banned.token, ev())],
    ["the deck", () => call(R.matches.GET, `events/${w.eventId}/matches`, w.banned.token, ev())],
    ["the night's people", () => call(R.people.GET, `events/${w.eventId}/people`, w.banned.token, ev())],
    ["the crews here", () => call(R.crews.GET, `events/${w.eventId}/crews`, w.banned.token, ev())],
    ["who they may rate", () => call(R.peerRatings.GET, `events/${w.eventId}/peer-ratings`, w.banned.token, ev())],
    ["a rating", () => call(R.peerRatings.POST, `events/${w.eventId}/peer-ratings`, w.banned.token, ev(), "POST", { userId: w.here.id, rating: 1 })],
    ["a wave", () => call(R.waves.POST, `events/${w.eventId}/waves`, w.banned.token, ev(), "POST", { toUserId: handleOf(w.here) })],
    ["a like", () => call(R.likes.POST, `events/${w.eventId}/matches/likes`, w.banned.token, ev(), "POST", { userId: handleOf(w.here) })],
    ["a reveal", () => call(R.preferences.PUT, `events/${w.eventId}/matches/preferences`, w.banned.token, ev(), "PUT", { revealed: true })],
    ["the profile behind a handle", () => call(R.user.GET, `users/${handleOf(w.here)}`, w.banned.token, { userId: handleOf(w.here) })],
    ["the card behind a handle", () => call(R.profile.GET, `profiles/${handleOf(w.here)}`, w.banned.token, { userId: handleOf(w.here) })],
    ["the interests behind a handle", () => call(R.interests.GET, `profiles/${handleOf(w.here)}/interests`, w.banned.token, { userId: handleOf(w.here) })],
    ["a message request to a handle", () => call(R.messageRequests.POST, "message-requests", w.banned.token, {}, "POST", { recipientId: handleOf(w.here), message: "hi" })],
  ])("%s", async (_, ask) => {
    const res = await ask()
    expect(res.status).toBe(403)
    expect(res.json).toMatchObject(REFUSED)
  })

  it("is not in the room to anybody waving or liking: the not-here answers, never the ban", async () => {
    const wave = await call(R.waves.POST, `events/${w.eventId}/waves`, w.here.token, ev(), "POST", { toUserId: handleOf(w.banned) })
    expect(wave).toMatchObject({ status: 403, json: { errorCode: "RECIPIENT_NOT_HERE" } })
    const like = await call(R.likes.POST, `events/${w.eventId}/matches/likes`, w.here.token, ev(), "POST", { userId: handleOf(w.banned) })
    expect(like).toMatchObject({ status: 404, json: { error: "User not found" } })
    expect(await db.event_likes.count({ where: { event_id: w.eventId, liked_id: w.banned.id } })).toBe(0)
  })

  it("is not listed to anybody: not on the roster, not in the deck (\"listed but not here\" would give it away)", async () => {
    const roster = await call(R.roster.GET, `events/${w.eventId}/checkins`, w.here.token, ev())
    expect(roster.status).toBe(200)
    expect(JSON.stringify(roster.json)).not.toContain(handleOf(w.banned))
    const deck = await call(R.matches.GET, `events/${w.eventId}/matches`, w.here.token, ev())
    expect(deck.status).toBe(200)
    expect(JSON.stringify(deck.json)).not.toContain(handleOf(w.banned))
  })

  it("counts only a host's ban: suspended and reinstated, a person is listed and may act again (M2)", async () => {
    const back = await person()
    await db.event_check_ins.create({ data: { event_id: w.eventId, occurrence_id: await occurrenceOf(w.eventId), user_id: back.id, status: "checked_in", check_in_time: new Date() } })
    await db.chat_group_members.create({ data: { chat_group_id: w.groupId, user_id: back.id, anonymous_name: testId("Heron") } })
    // A suspension bans every room with banned_by null; lifting it does not unban.
    await db.$transaction(async (tx) => {
      await applySuspension(tx, back.id, "itest-admin")
      await liftSuspension(tx, back.id)
    })
    expect(await db.chat_group_members.findFirstOrThrow({ where: { chat_group_id: w.groupId, user_id: back.id } })).toMatchObject({ status: "banned", banned_by: null })

    const token = signAccessToken(back.id, `${back.id}@itest.invalid`)
    expect((await call(R.roster.GET, `events/${w.eventId}/checkins`, token, ev())).status).toBe(200)
    expect((await call(R.matches.GET, `events/${w.eventId}/matches`, token, ev())).status).toBe(200)
    const like = await call(R.likes.POST, `events/${w.eventId}/matches/likes`, token, ev(), "POST", { userId: handleOf(w.here) })
    expect(like.status).toBe(200)
    const roster = await call(R.roster.GET, `events/${w.eventId}/checkins`, w.here.token, ev())
    expect(JSON.stringify(roster.json)).toContain(handleOf(back))
  })

  it("leaves everybody in good standing as they were, and opens again when the ban is lifted", async () => {
    expect((await call(R.roster.GET, `events/${w.eventId}/checkins`, w.here.token, ev())).status).toBe(200)
    expect((await call(R.crews.GET, `events/${w.eventId}/crews`, w.here.token, ev())).status).toBe(200)
    expect((await call(R.user.GET, `users/${handleOf(w.banned)}`, w.here.token, { userId: handleOf(w.banned) })).status).toBe(200)

    await db.chat_group_members.updateMany({ where: { chat_group_id: w.groupId, user_id: w.banned.id }, data: { status: "active", banned_by: null } })
    expect((await call(R.roster.GET, `events/${w.eventId}/checkins`, w.banned.token, ev())).status).toBe(200)
    expect((await call(R.user.GET, `users/${handleOf(w.here)}`, w.banned.token, { userId: handleOf(w.here) })).status).toBe(200)
    await db.chat_group_members.updateMany({ where: { chat_group_id: w.groupId, user_id: w.banned.id }, data: { status: "banned", banned_by: "itest" } })
  })
})
