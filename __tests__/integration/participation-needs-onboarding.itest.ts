import { NextRequest } from "next/server"

/*
 * Nobody takes part before they have finished onboarding or shown they are an
 * adult (SCRUM-331).
 *
 * Blend'n is 18+ (SCRUM-330). Google and Apple accounts arrive with no age and
 * the app holds them at "The basics" until a birth date of 18+ is on file — but
 * that hold was a client convention. Found by the SCRUM-330 security review: no
 * participation route read `profiles.onboarded`, so an account that skipped
 * onboarding (a modified client, the raw API) could RSVP, check in, read and
 * post on the board, and DM, with no age on file at all.
 *
 * The rule: a profile may participate if it finished onboarding, or if its age
 * is known and 18+. Onboarded accounts with no age (17 on staging, from before
 * age was asked) keep working; so does a new email account mid-onboarding,
 * whose age sign-up already checked. Real routes, real rows.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/tigris", () => ({ deletePrefix: jest.fn().mockResolvedValue(0) }))
import { signAccessToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeEvent, makeUser } from "./helpers"
/* eslint-disable @typescript-eslint/no-require-imports */
const rsvp = require("@/app/api/mobile/events/[eventId]/rsvp/route") as typeof import("@/app/api/mobile/events/[eventId]/rsvp/route")
const favorite = require("@/app/api/mobile/events/[eventId]/favorite/route") as typeof import("@/app/api/mobile/events/[eventId]/favorite/route")
const board = require("@/app/api/mobile/events/[eventId]/board/route") as typeof import("@/app/api/mobile/events/[eventId]/board/route")
const checkin = require("@/app/api/mobile/events/[eventId]/checkin/route") as typeof import("@/app/api/mobile/events/[eventId]/checkin/route")
const conversations = require("@/app/api/mobile/conversations/route") as typeof import("@/app/api/mobile/conversations/route")
const dm = require("@/app/api/mobile/conversations/[conversationId]/messages/route") as typeof import("@/app/api/mobile/conversations/[conversationId]/messages/route")
const requests = require("@/app/api/mobile/message-requests/route") as typeof import("@/app/api/mobile/message-requests/route")
const eventDetail = require("@/app/api/mobile/events/[eventId]/route") as typeof import("@/app/api/mobile/events/[eventId]/route")
const interest = require("@/app/api/mobile/events/[eventId]/interest/route") as typeof import("@/app/api/mobile/events/[eventId]/interest/route")
const boardRequests = require("@/app/api/mobile/events/[eventId]/board/[postId]/requests/route") as typeof import("@/app/api/mobile/events/[eventId]/board/[postId]/requests/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const users: string[] = []
const events: string[] = []
const convos: string[] = []
afterAll(async () => {
  await db.private_messages.deleteMany({ where: { conversation_id: { in: convos } } })
  await db.private_conversations.deleteMany({ where: { id: { in: convos } } })
  await db.message_requests.deleteMany({ where: { sender_id: { in: users } } })
  await db.event_rsvps.deleteMany({ where: { user_id: { in: users } } })
  await db.event_favorites.deleteMany({ where: { user_id: { in: users } } })
  await db.profiles.deleteMany({ where: { id: { in: users } } })
  await cleanup(users, events)
  await closeDb()
})

type Profile = { onboarded: boolean; age?: number; date_of_birth?: Date }
async function person(label: string, profile: Profile) {
  const id = await makeUser(label)
  users.push(id)
  await db.profiles.create({ data: { id, name: label, ...profile } })
  const { email } = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
  return { id, token: signAccessToken(id, email) }
}

let ip = 0
const req = (url: string, token: string, method: string, body?: unknown) =>
  new NextRequest(`http://localhost${url}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "x-real-ip": `10.34.0.${++ip}`,
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  })
const eventParams = (eventId: string) => ({ params: Promise.resolve({ eventId }) })

const SENTENCE = "Finish setting up your profile first. Blend'n is for people 18 and over."
async function refused(res: Response) {
  expect(res.status).toBe(403)
  expect(((await res.json()) as { error: string }).error).toBe(SENTENCE)
}

let eventId = ""
let host = ""
beforeAll(async () => {
  host = await makeUser("pno-host", "organizer")
  users.push(host)
  eventId = await makeEvent(host)
  events.push(eventId)
})

describe("an account that skipped onboarding with no age on file", () => {
  let who: { id: string; token: string }
  beforeAll(async () => {
    who = await person("pno-skipped", { onboarded: false })
  })

  it("can still look at the event — the gate is on taking part, not on looking", async () => {
    const res = await eventDetail.GET(req(`/api/mobile/events/${eventId}`, who.token, "GET"), eventParams(eventId))
    expect(res.status).toBe(200)
  })

  it("cannot RSVP", async () => {
    await refused(await rsvp.POST(req(`/api/mobile/events/${eventId}/rsvp`, who.token, "POST", { status: "going" }), eventParams(eventId)))
    expect(await db.event_rsvps.count({ where: { user_id: who.id } })).toBe(0)
  })

  it("cannot save the event", async () => {
    await refused(await favorite.POST(req(`/api/mobile/events/${eventId}/favorite`, who.token, "POST"), eventParams(eventId)))
    expect(await db.event_favorites.count({ where: { user_id: who.id } })).toBe(0)
  })

  it("cannot read the board", async () => {
    await refused(await board.GET(req(`/api/mobile/events/${eventId}/board`, who.token, "GET"), eventParams(eventId)))
  })

  it("cannot mark interest, post on the board, or ask to join a post", async () => {
    await refused(await interest.POST(req(`/api/mobile/events/${eventId}/interest`, who.token, "POST", {}), eventParams(eventId)))
    await refused(
      await board.POST(req(`/api/mobile/events/${eventId}/board`, who.token, "POST", { kind: "chat", body: "anyone here?" }), eventParams(eventId))
    )
    // The door is asked before the post is looked up, so any post id reaches it.
    const postId = "00000000-0000-4000-8000-000000000331"
    await refused(
      await boardRequests.POST(req(`/api/mobile/events/${eventId}/board/${postId}/requests`, who.token, "POST", {}), {
        params: Promise.resolve({ eventId, postId }),
      })
    )
  })

  it("cannot check in", async () => {
    await refused(
      await checkin.POST(req(`/api/mobile/events/${eventId}/checkin`, who.token, "POST", { latitude: 12.97, longitude: 77.59 }), eventParams(eventId))
    )
    expect(await db.event_check_ins.count({ where: { user_id: who.id } })).toBe(0)
  })

  it("cannot start a conversation, send a request, or send a DM", async () => {
    const other = await person("pno-other", { onboarded: true, age: 30 })

    await refused(await conversations.POST(req("/api/mobile/conversations", who.token, "POST", { otherUserId: other.id })))
    await refused(
      await requests.POST(req("/api/mobile/message-requests", who.token, "POST", { recipientId: other.id, message: "hello there" }))
    )
    expect(await db.message_requests.count({ where: { sender_id: who.id } })).toBe(0)

    const convo = await db.private_conversations.create({
      data: { user1_id: who.id, user2_id: other.id, user1_pseudonym: "Quiet Otter", user2_pseudonym: "Amber Fox" },
    })
    convos.push(convo.id)
    await refused(
      await dm.POST(req(`/api/mobile/conversations/${convo.id}/messages`, who.token, "POST", { text: "hi" }), {
        params: Promise.resolve({ conversationId: convo.id }),
      })
    )
    expect(await db.private_messages.count({ where: { conversation_id: convo.id } })).toBe(0)
  })
})

describe("accounts that may take part", () => {
  it("an onboarded account with no age — from before age was asked", async () => {
    const who = await person("pno-onb-noage", { onboarded: true })
    const res = await rsvp.POST(req(`/api/mobile/events/${eventId}/rsvp`, who.token, "POST", { status: "going" }), eventParams(eventId))
    expect(res.status).toBe(200)
  })

  it("an adult still in onboarding — email sign-up already checked the age", async () => {
    const who = await person("pno-adult-mid", { onboarded: false, age: 25 })
    const res = await rsvp.POST(req(`/api/mobile/events/${eventId}/rsvp`, who.token, "POST", { status: "going" }), eventParams(eventId))
    expect(res.status).toBe(200)
  })

  it("an onboarded under-18 from before the ruling is left alone", async () => {
    const who = await person("pno-teen", { onboarded: true, age: 16 })
    const res = await rsvp.POST(req(`/api/mobile/events/${eventId}/rsvp`, who.token, "POST", { status: "going" }), eventParams(eventId))
    expect(res.status).toBe(200)
  })
})

it("holds someone under 18 who never finished onboarding", async () => {
  const who = await person("pno-teen-mid", { onboarded: false, age: 16 })
  await refused(await rsvp.POST(req(`/api/mobile/events/${eventId}/rsvp`, who.token, "POST", { status: "going" }), eventParams(eventId)))
})
