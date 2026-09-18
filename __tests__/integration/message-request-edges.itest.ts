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
import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, putInRoom, testId } from "./helpers"

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

describe("asking", () => {
  let a: { id: string; token: string }
  let b: { id: string; token: string }

  beforeAll(async () => {
    const host = await makeUser(testId("mr-host"), "organizer")
    users.push(host)
    const eventId = await makeEvent(host)
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

    const again = await ask(a.token, b.id)
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ error: "You have already sent a request to this user" })

    const reverse = await ask(b.token, a.id)
    expect(reverse.status).toBe(201)
    expect(await db.message_requests.count({ where: { sender_id: b.id, recipient_id: a.id, status: "pending" } })).toBe(1)
  })

  it("a pending request still blocks the other direction (negative control)", async () => {
    // b → a is pending from the previous test; a asking b again is refused with
    // the "check your incoming requests" sentence, which is now true.
    await db.message_requests.deleteMany({ where: { sender_id: a.id, recipient_id: b.id } })
    const res = await ask(a.token, b.id)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({
      error: "This user has already sent you a request. Check your incoming requests.",
    })
  })
})
