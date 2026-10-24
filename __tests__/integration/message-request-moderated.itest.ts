import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeEvent, makeUser, occurrenceOf, onboard, putInRoom } from "./helpers"

/*
 * API M1 (security audit): a message request's text went to a stranger with
 * none of the deterministic checks every other channel runs. The same
 * pre-save check as a room message (`preSaveCheck`) now refuses it, before
 * anything is stored or pushed.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const route = require("@/app/api/mobile/message-requests/route") as typeof import("@/app/api/mobile/message-requests/route")

const users: string[] = []
const events: string[] = []
afterAll(async () => {
  await db.message_requests.deleteMany({ where: { sender_id: { in: users } } })
  await cleanup(users, events)
  await closeDb()
})

async function person(label: string) {
  const id = await makeUser(label)
  users.push(id)
  await onboard(id)
  return { id, token: signAccessToken(id, `${id}@itest.invalid`) }
}

const ask = (token: string, recipientId: string, message: string) =>
  route.POST(
    new NextRequest("http://localhost/api/mobile/message-requests", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ recipientId, message }),
    })
  )

/** Two people in one room: the only way a request reaches the text check. */
async function pairInARoom() {
  const host = await makeUser("mr_host", "organizer")
  users.push(host)
  const eventId = await makeEvent(host)
  events.push(eventId)
  const [a, b] = [await person("mr_a"), await person("mr_b")]
  const occ = await occurrenceOf(eventId)
  await putInRoom({ eventId, occurrenceId: occ, userId: a.id })
  await putInRoom({ eventId, occurrenceId: occ, userId: b.id })
  return { a, b }
}

it("lets a clean intro through (negative control)", async () => {
  const { a, b } = await pairInARoom()
  expect((await ask(a.token, b.id, "loved your take on the keynote, coffee?")).status).toBe(201)
  expect(await db.message_requests.count({ where: { sender_id: a.id } })).toBe(1)
})

it.each(["call me on 9876543210 tonight", "mail me at someone@example.com", "add me on instagram @someone_else"])(
  "refuses %j before storing it",
  async (text) => {
    const { a, b } = await pairInARoom()
    const res = await ask(a.token, b.id, text)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("can't be sent") })
    expect(await db.message_requests.count({ where: { sender_id: a.id } })).toBe(0)
  }
)
