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

it("pushes the first tap once, as the ask, however many times it is repeated", async () => {
  const { a, id } = await pair()
  expect(await call(a, id)).toBe(200)
  expect(await call(a, id)).toBe(200)
  expect(await call(a, id)).toBe(200)
  expect(notifyRevealRequest).toHaveBeenCalledTimes(1)
  expect(notifyReveal).not.toHaveBeenCalled()
})

it("pushes the swap once, to the one who tapped first", async () => {
  const { a, b, id } = await pair()
  await call(a, id)
  jest.clearAllMocks()
  expect(await call(b, id)).toBe(200)
  expect(await call(b, id)).toBe(200)
  expect(notifyReveal).toHaveBeenCalledTimes(1)
  expect(notifyReveal).toHaveBeenCalledWith(a.id, id)
  expect(notifyRevealRequest).not.toHaveBeenCalled()
})

it("pushes once when two taps race", async () => {
  const { a, id } = await pair()
  const statuses = await Promise.all([call(a, id), call(a, id), call(a, id)])
  expect(statuses).toEqual([200, 200, 200])
  expect(notifyRevealRequest).toHaveBeenCalledTimes(1)
})

it("pushes the ask once per conversation, even across a cancel and a re-tap (no nag loop)", async () => {
  const { a, id } = await pair()
  const cancel = () =>
    revealRoute
      .DELETE(
        new NextRequest(`http://localhost/api/mobile/conversations/${id}/reveal`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${a.token}` },
        }),
        { params: Promise.resolve({ conversationId: id }) }
      )
      .then((r) => r.status)
  for (let i = 0; i < 3; i++) {
    expect(await call(a, id)).toBe(200)
    expect(await cancel()).toBe(200)
  }
  expect(notifyRevealRequest).toHaveBeenCalledTimes(1)
})

const cancelAs = (as: { token: string }, conversationId: string) =>
  revealRoute
    .DELETE(
      new NextRequest(`http://localhost/api/mobile/conversations/${conversationId}/reveal`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${as.token}` },
      }),
      { params: Promise.resolve({ conversationId }) }
    )
    .then((r) => r.status)
const flags = (id: string) =>
  db.private_conversations.findUniqueOrThrow({ where: { id }, select: { user1_revealed: true, user2_revealed: true } })

it("a cancel after both have swapped is a 409 and changes nothing", async () => {
  const { a, b, id } = await pair()
  await call(a, id)
  await call(b, id)
  expect(await cancelAs(a, id)).toBe(409)
  expect(await flags(id)).toEqual({ user1_revealed: true, user2_revealed: true })
})

it("two taps at the same moment push exactly one 'Names swapped'", async () => {
  for (let i = 0; i < 5; i++) {
    const { a, b, id } = await pair()
    jest.clearAllMocks()
    expect(await Promise.all([call(a, id), call(b, id)])).toEqual([200, 200])
    expect(await flags(id)).toEqual({ user1_revealed: true, user2_revealed: true })
    expect(notifyReveal).toHaveBeenCalledTimes(1)
  }
})

it("a cancel racing the other side's tap never leaves a swap with a cancelled side or a cancel of a swap", async () => {
  for (let i = 0; i < 5; i++) {
    const { a, b, id } = await pair()
    await call(a, id)
    const [cancelled, tapped] = await Promise.all([cancelAs(a, id), call(b, id)])
    expect(tapped).toBe(200)
    const after = await flags(id)
    const aIs1 = (await db.private_conversations.findUniqueOrThrow({ where: { id }, select: { user1_id: true } })).user1_id === a.id
    const [aSide, bSide] = aIs1 ? [after.user1_revealed, after.user2_revealed] : [after.user2_revealed, after.user1_revealed]
    expect(bSide).toBe(true)
    // Either the cancel won (A off, B now asking) or the tap won (swapped, cancel refused).
    if (cancelled === 409) expect(aSide).toBe(true)
    else {
      expect(cancelled).toBe(200)
      expect(aSide).toBe(false)
    }
  }
})

it("refuses the removed ask body", async () => {
  const { a, id } = await pair()
  expect(await call(a, id, { ask: true })).toBe(400)
  expect(notifyRevealRequest).not.toHaveBeenCalled()
})
