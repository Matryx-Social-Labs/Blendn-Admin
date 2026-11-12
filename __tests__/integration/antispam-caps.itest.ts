import { NextRequest } from "next/server"

/*
 * The person-to-person caps the owner approved on 2026-11-12 (SCRUM-1050,
 * `.context/plans/anti-spam.md` § OWNER APPROVED):
 *
 * - message requests: an account under 24 h sends 3 a day; at most 10 unanswered at once;
 * - reports: 30 a day in total, across every report door (it was 30 per door);
 * - crew likes: 30 a day.
 *
 * Every one is a sender limit, checked before the recipient is looked at, so a
 * refusal says nothing about them: each test that expects a 429 sends to an id
 * nobody has, which would otherwise be the 404.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"
import { overUserLimit } from "@/lib/rate-limit"
import { logger } from "@/lib/logger"
import { cleanup, closeDb, db, makeEvent, makeUser, onboard, occurrenceOf, putInRoom, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const requestsRoute = require("@/app/api/mobile/message-requests/route") as typeof import("@/app/api/mobile/message-requests/route")
const userReport = require("@/app/api/mobile/users/[userId]/report/route") as typeof import("@/app/api/mobile/users/[userId]/report/route")
const eventReport = require("@/app/api/mobile/events/[eventId]/report/route") as typeof import("@/app/api/mobile/events/[eventId]/report/route")
const personLike = require("@/app/api/mobile/events/[eventId]/matches/likes/route") as typeof import("@/app/api/mobile/events/[eventId]/matches/likes/route")
const crewLike = require("@/app/api/mobile/events/[eventId]/crews/[crewId]/like/route") as typeof import("@/app/api/mobile/events/[eventId]/crews/[crewId]/like/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const DAY = 24 * 60 * 60 * 1000
const NOBODY = "cnobodyhasthisid000000000"
const ID = "11111111-1111-4111-8111-111111111111"
const users: string[] = []
const events: string[] = []

afterAll(async () => {
  await db.message_requests.deleteMany({ where: { sender_id: { in: users } } })
  await cleanup(users, events)
  await closeDb()
})

/** An onboarded attendee whose account is `ageMs` old. */
async function person(label: string, ageMs = 2 * DAY) {
  const id = await makeUser(testId(label))
  users.push(id)
  await onboard(id)
  await db.user.update({ where: { id }, data: { createdAt: new Date(Date.now() - ageMs) } })
  return { id, token: signAccessToken(id, `${id}@itest.invalid`) }
}

const req = (url: string, token: string, body: unknown) =>
  new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })

const ask = async (as: { token: string }, recipientId: string) => {
  const res = await requestsRoute.POST(req("http://localhost/api/mobile/message-requests", as.token, { recipientId, message: "coffee?" }))
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

/** `n` requests from `senderId` already on file, to fresh people, in `status`, sent `agoMs` ago. */
async function onFile(senderId: string, n: number, status: "pending" | "accepted" | "declined" | "blocked", agoMs = 0) {
  for (let i = 0; i < n; i++) {
    const to = await makeUser(testId("ac_to"))
    users.push(to)
    await db.message_requests.create({
      data: { sender_id: senderId, recipient_id: to, message: "hi", status, created_at: new Date(Date.now() - agoMs) },
    })
  }
}

function expectRateLimited(r: { status: number; body: Record<string, unknown> }) {
  expect(r.status).toBe(429)
  expect(r.body).toMatchObject({ success: false, errorCode: "RATE_LIMITED" })
  expect(r.body.retryAfter).toEqual(expect.any(Number))
}

describe("message requests from an account under 24 hours old", () => {
  it("allows 3 a day, then refuses with the rate-limit answer, whoever the 4th is to", async () => {
    const fresh = await person("ac_new", 2 * 60 * 60 * 1000)
    for (let i = 0; i < 3; i++) expect((await ask(fresh, NOBODY)).status).toBe(404)
    expectRateLimited(await ask(fresh, NOBODY))
  })

  it("logs one abuse.cap_hit line for the window, with the sender and the cap and nothing they wrote", async () => {
    const warn = jest.spyOn(logger, "warn")
    try {
      const fresh = await person("ac_log", 60 * 60 * 1000)
      for (let i = 0; i < 5; i++) await ask(fresh, NOBODY)
      const hits = warn.mock.calls.filter(([message]) => message === "abuse.cap_hit")
      expect(hits).toEqual([["abuse.cap_hit", { userId: fresh.id, gesture: "message-request-day-new", cap: 3 }]])
    } finally {
      warn.mockRestore()
    }
  })

  it("control: an account older than a day is not held to 3", async () => {
    const old = await person("ac_old", DAY + 60 * 60 * 1000)
    for (let i = 0; i < 5; i++) expect((await ask(old, NOBODY)).status).toBe(404)
  })
})

describe("at most 10 unanswered message requests at once", () => {
  it("refuses the 11th before the recipient is looked at", async () => {
    const a = await person("ac_10")
    await onFile(a.id, 10, "pending")
    expectRateLimited(await ask(a, NOBODY))
  })

  it("control: 9 unanswered and one accepted is room for another", async () => {
    const a = await person("ac_9a")
    await onFile(a.id, 9, "pending")
    await onFile(a.id, 1, "accepted")
    expect((await ask(a, NOBODY)).status).toBe(404)
  })

  it("counts a declined request as unanswered, because a decline is never told", async () => {
    const a = await person("ac_9d")
    await onFile(a.id, 9, "pending")
    await onFile(a.id, 1, "declined")
    expectRateLimited(await ask(a, NOBODY))
  })

  it("counts a request the recipient blocked on, because a block is never told either", async () => {
    const a = await person("ac_9b")
    await onFile(a.id, 9, "pending")
    await onFile(a.id, 1, "blocked")
    expectRateLimited(await ask(a, NOBODY))
  })

  it("lets an unanswered request age out after a week", async () => {
    const a = await person("ac_old10")
    await onFile(a.id, 10, "pending", 8 * DAY)
    expect((await ask(a, NOBODY)).status).toBe(404)
  })

  it("counts the silent 201 too, so the cap cannot tell a real request from an existing one", async () => {
    // a asks b once (real), then again: the second is the synthetic 201 with no row (SCRUM-371).
    const host = await makeUser(testId("ac_host"), "organizer")
    users.push(host)
    const eventId = await makeEvent(host)
    events.push(eventId)
    const [a, b] = [await person("ac_syn_a"), await person("ac_syn_b")]
    const occ = await occurrenceOf(eventId)
    await putInRoom({ eventId, occurrenceId: occ, userId: a.id })
    await putInRoom({ eventId, occurrenceId: occ, userId: b.id })
    await onFile(a.id, 8, "pending")

    expect((await ask(a, b.id)).status).toBe(201)
    expect((await ask(a, b.id)).status).toBe(201)
    expect(await db.message_requests.count({ where: { sender_id: a.id } })).toBe(9)
    expectRateLimited(await ask(a, NOBODY))
  })

  it("control: without the silent 201, nine on file leaves room", async () => {
    const a = await person("ac_syn_ctl")
    await onFile(a.id, 9, "pending")
    expect((await ask(a, NOBODY)).status).toBe(404)
  })
})

describe("message request by raw user id, to someone never at one of your events", () => {
  it("answers as an id nobody has", async () => {
    const [a, b] = [await person("ac_raw_a"), await person("ac_raw_b")]
    const toStranger = await ask(a, b.id)
    const toNobody = await ask(a, NOBODY)
    expect(toStranger.status).toBe(404)
    expect(toStranger.body).toEqual(toNobody.body)
  })
})

describe("reports: 30 a day in total, across the doors", () => {
  it("a 31st report through a second door is refused", async () => {
    const me = await person("ac_rep")
    // 30 spent through the user door's bucket…
    for (let i = 0; i < 30; i++) await overUserLimit("reportDay", "report-day", me.id)
    // …and the event door refuses the next.
    const res = await eventReport.POST(req(`http://localhost/api/mobile/events/${ID}/report`, me.token, { reason: "spam" }), {
      params: Promise.resolve({ eventId: ID }),
    })
    expectRateLimited({ status: res.status, body: (await res.json()) as Record<string, unknown> })
  })

  it("control: 29 spent leaves the 30th through", async () => {
    const me = await person("ac_rep29")
    for (let i = 0; i < 29; i++) await overUserLimit("reportDay", "report-day", me.id)
    const res = await userReport.POST(req(`http://localhost/api/mobile/users/${NOBODY}/report`, me.token, { reason: "spam" }), {
      params: Promise.resolve({ userId: NOBODY }),
    })
    expect(res.status).not.toBe(429)
  })
})

describe("crew likes: 30 a day", () => {
  const like = async (as: { token: string }) => {
    const res = await crewLike.POST(req(`http://localhost/api/mobile/events/${ID}/crews/${ID}/like`, as.token, {}), {
      params: Promise.resolve({ eventId: ID, crewId: ID }),
    })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  it("refuses the 31st of the day, before the crew is looked at", async () => {
    const me = await person("ac_like")
    for (let i = 0; i < 30; i++) await overUserLimit("crewLikeDay", "crew-like-day", me.id)
    expectRateLimited(await like(me))
  })

  it("counts a like of a person on a crew's behalf in the same 30, and not a like as yourself", async () => {
    const me = await person("ac_like_p")
    for (let i = 0; i < 30; i++) await overUserLimit("crewLikeDay", "crew-like-day", me.id)
    const likePerson = async (body: object) => {
      const res = await personLike.POST(req(`http://localhost/api/mobile/events/${ID}/matches/likes`, me.token, body), {
        params: Promise.resolve({ eventId: ID }),
      })
      return { status: res.status, body: (await res.json()) as Record<string, unknown> }
    }
    expectRateLimited(await likePerson({ userId: NOBODY, asCrewId: ID }))
    // Control: the same person liking as themselves is not a crew like.
    expect((await likePerson({ userId: NOBODY })).status).not.toBe(429)
  })

  it("control: the 30th goes through to the crew", async () => {
    const me = await person("ac_like29")
    for (let i = 0; i < 29; i++) await overUserLimit("crewLikeDay", "crew-like-day", me.id)
    expect((await like(me)).status).not.toBe(429)
  })
})
