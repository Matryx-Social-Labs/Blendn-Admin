import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/push-notifications", () => ({
  ...jest.requireActual("@/lib/push-notifications"),
  notifyReveal: jest.fn().mockResolvedValue(undefined),
  notifyRevealRequest: jest.fn().mockResolvedValue(undefined),
}))

import { signAccessToken } from "@/lib/mobile-auth"
import { conversationPair } from "@/lib/conversations"
import { notifyReveal, notifyRevealRequest } from "@/lib/push-notifications"
import { cleanup, closeDb, db, makeUser, onboard } from "./helpers"

/*
 * API M4 (security audit): ask-to-reveal and reveal pushed the other person on
 * every call, so the one who cannot decline (only block) could be pushed ~43k
 * times a day. A push goes out only when the state actually changed.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const revealRoute = require("@/app/api/mobile/conversations/[conversationId]/reveal/route") as typeof import("@/app/api/mobile/conversations/[conversationId]/reveal/route")

const users: string[] = []
afterAll(async () => {
  await cleanup(users, [])
  await closeDb()
})

async function person(label: string) {
  const id = await makeUser(label)
  users.push(id)
  await onboard(id)
  await db.profiles.update({ where: { id }, data: { name: label, photos: [`https://img.invalid/${label}.jpg`] } })
  return { id, token: signAccessToken(id, `${id}@itest.invalid`) }
}

const call = (as: { token: string }, conversationId: string, body?: unknown) =>
  revealRoute
    .POST(
      new NextRequest(`http://localhost/api/mobile/conversations/${conversationId}/reveal`, {
        method: "POST",
        headers: { authorization: `Bearer ${as.token}`, "content-type": "application/json" },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      }),
      { params: Promise.resolve({ conversationId }) }
    )
    .then((r) => r.status)

async function pair() {
  const a = await person("rv_a")
  const b = await person("rv_b")
  const [user1_id, user2_id] = conversationPair(a.id, b.id)
  const row = await db.private_conversations.create({
    data: { user1_id, user2_id, user1_pseudonym: "Otter", user2_pseudonym: "Heron" },
  })
  return { a, b, id: row.id }
}

beforeEach(() => jest.clearAllMocks())

it("pushes an ask once, however many times it is repeated", async () => {
  const { a, id } = await pair()
  expect(await call(a, id, { ask: true })).toBe(200)
  expect(await call(a, id, { ask: true })).toBe(200)
  expect(await call(a, id, { ask: true })).toBe(200)
  expect(notifyRevealRequest).toHaveBeenCalledTimes(1)
})

it("pushes a reveal once, however many times it is repeated", async () => {
  const { a, id } = await pair()
  expect(await call(a, id)).toBe(200)
  expect(await call(a, id)).toBe(200)
  expect(notifyReveal).toHaveBeenCalledTimes(1)
})
