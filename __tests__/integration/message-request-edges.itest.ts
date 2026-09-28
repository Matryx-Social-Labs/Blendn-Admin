import { NextRequest } from "next/server"

/*
 * The edges of asking (SCRUM-165 / SCRUM-182).
 *
 * Driven on staging: Vikram asked Ananya, she declined on the phone, and then
 * neither could ever ask again — he got "already sent" (right), she got "this
 * user has already sent you a request, check your incoming requests" about a
 * request that no longer appears there. And the response to Vikram's ask had
 * carried Ananya's real name and photo before she had done anything.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeEvent, makeUser, onboard, occurrenceOf, putInRoom, testId } from "./helpers"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const requestsRoute = require("@/app/api/mobile/message-requests/route") as
  typeof import("@/app/api/mobile/message-requests/route")

const users: string[] = []
const events: string[] = []

afterAll(async () => {
  await db.message_requests.deleteMany({ where: { sender_id: { in: users } } })
  await cleanup(users, events)
  await closeDb()
})

async function person(label: string) {
  const id = await makeUser(testId(label), "attendee")
  users.push(id)
  await onboard(id)
  await db.user.update({ where: { id }, data: { name: `Real ${label}`, image: "https://example.test/face.jpg" } })
  const user = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
  return { id, token: signAccessToken(id, user.email) }
}

const ask = (token: string, recipientId: string) =>
  requestsRoute.POST(
    new NextRequest("http://localhost/api/mobile/message-requests", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ recipientId, message: "coffee?" }),
    })
  )

/*
 * Whether a refusal is SAID depends on whether the asker may already see who
 * this is (SCRUM-371). To someone the room keeps a stranger, "you already asked"
 * or "they already asked you" is a fact about the pair that a room handle
 * hides, so it reads as a fresh 201 and nothing is written — see the route.
 * `b` revealing in the room is what lets `a` see who `b` is, and so hear the 409.
 */
const reveal = (eventId: string, userId: string, revealed: boolean) =>
  db.event_match_preferences.upsert({
    where: { event_id_user_id: { event_id: eventId, user_id: userId } },
    create: { event_id: eventId, user_id: userId, revealed },
    update: { revealed },
  })

describe("asking", () => {
  let a: { id: string; token: string }
  let b: { id: string; token: string }
  let eventId: string

  beforeAll(async () => {
    const host = await makeUser(testId("mr-host"), "organizer")
    users.push(host)
    eventId = await makeEvent(host)
    events.push(eventId)
    ;[a, b] = await Promise.all([person("mr-a"), person("mr-b")])
    const occ = await occurrenceOf(eventId)
    await putInRoom({ eventId, occurrenceId: occ, userId: a.id })
    await putInRoom({ eventId, occurrenceId: occ, userId: b.id })
  })

  it("tells the sender the recipient's id and nothing that names them", async () => {
    const res = await ask(a.token, b.id)
    expect(res.status).toBe(201)
    const body = (await res.json()) as { data: { request: { recipient: Record<string, unknown> } } }
    expect(body.data.request.recipient).toEqual({ id: b.id })
    expect(JSON.stringify(body)).not.toContain("Real mr-b")
    expect(JSON.stringify(body)).not.toContain("face.jpg")
  })

  it("after a decline, the sender may not ask again and the decliner may", async () => {
    await db.message_requests.updateMany({
      where: { sender_id: a.id, recipient_id: b.id },
      data: { status: "declined" },
    })

    // A stranger to b: the refusal is not said, and nothing is sent either.
    const again = await ask(a.token, b.id)
    expect(again.status).toBe(201)
    expect(await db.message_requests.findMany({ where: { sender_id: a.id, recipient_id: b.id }, select: { status: true } }))
      .toEqual([{ status: "declined" }])

    // Once b is someone a can see, the refusal is said, as it always was.
    await reveal(eventId, b.id, true)
    const seen = await ask(a.token, b.id)
    expect(seen.status).toBe(409)
    expect(await seen.json()).toMatchObject({ error: "You have already sent a request to this user" })
    await reveal(eventId, b.id, false)

    const reverse = await ask(b.token, a.id)
    expect(reverse.status).toBe(201)
    expect(await db.message_requests.count({ where: { sender_id: b.id, recipient_id: a.id, status: "pending" } })).toBe(1)
  })

  it("a pending request still blocks the other direction (negative control)", async () => {
    // b → a is pending from the previous test; a asking b writes nothing.
    await db.message_requests.deleteMany({ where: { sender_id: a.id, recipient_id: b.id } })
    const res = await ask(a.token, b.id)
    expect(res.status).toBe(201)
    expect(await db.message_requests.count({ where: { sender_id: a.id, recipient_id: b.id } })).toBe(0)

    // And to someone who can see b, it says why: the sentence is true.
    await reveal(eventId, b.id, true)
    const seen = await ask(a.token, b.id)
    expect(seen.status).toBe(409)
    expect(await seen.json()).toMatchObject({
      error: "This user has already sent you a request. Check your incoming requests.",
    })
    await reveal(eventId, b.id, false)
  })
})
