/*
 * One device, one account (SCRUM-668).
 *
 * `push_tokens` was unique on (user_id, token), and the register route
 * upserted the caller's row and pruned only the caller's own. A phone whose
 * first account ended without a sign-out (an expired refresh token, a
 * reinstall that kept the Expo token, a suspension whose DELETE 401'd) and
 * then signed in as somebody else registered the same token under the second
 * account too -- and everything pushed to the first account, DM previews
 * included, rang the second person's phone.
 */
process.env.MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"

jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
type Ticket = { status: string; id?: string }
const sent = jest.fn(async (msgs: { to: string }[]): Promise<Ticket[]> => msgs.map(() => ({ status: "ok", id: "t" })))
jest.mock("expo-server-sdk", () => {
  class Expo {
    static isExpoPushToken(t: string) {
      return jest.requireActual("expo-server-sdk").Expo.isExpoPushToken(t)
    }
    chunkPushNotifications(m: unknown[]) {
      return [m]
    }
    sendPushNotificationsAsync(chunk: { to: string }[]) {
      return sent(chunk)
    }
  }
  return { Expo }
})

import { NextRequest } from "next/server"

import { logger } from "@/lib/logger"
import { signAccessToken } from "@/lib/mobile-auth"
import { sendPushNotification } from "@/lib/push-notifications"
import { MAX_TOKEN_MOVES_PER_HOUR } from "@/lib/push-token"
import { closeDb, db, makeUser, onboard, testId } from "./helpers"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const route = require("@/app/api/mobile/notifications/token/route") as typeof import("@/app/api/mobile/notifications/token/route")

const users: string[] = []
afterAll(async () => {
  await db.notifications.deleteMany({ where: { user_id: { in: users } } })
  await db.push_tokens.deleteMany({ where: { user_id: { in: users } } })
  await db.profiles.deleteMany({ where: { id: { in: users } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})
beforeEach(() => sent.mockClear())

async function person(label: string) {
  const id = await makeUser(label)
  users.push(id)
  await onboard(id)
  const { email } = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
  const auth = `Bearer ${signAccessToken(id, email)}`
  const register = (token: string, platform: "ios" | "android" = "ios") =>
    route.POST(
      new NextRequest("http://localhost/api/mobile/notifications/token", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: auth },
        body: JSON.stringify({ token, platform }),
      })
    )
  const remove = (token: string) =>
    route.DELETE(
      new NextRequest(`http://localhost/api/mobile/notifications/token?token=${encodeURIComponent(token)}`, {
        method: "DELETE",
        headers: { authorization: auth },
      })
    )
  return { id, register, remove }
}

const newToken = () => `ExponentPushToken[${testId("tok")}]`
const holders = async (token: string) => (await db.push_tokens.findMany({ where: { token }, select: { user_id: true } })).map((r) => r.user_id)

describe("registering a push token", () => {
  it("moves it to the account that registers it: the first account no longer holds it", async () => {
    const [a, b] = [await person("pt-a"), await person("pt-b")]
    const token = newToken()
    expect((await a.register(token)).status).toBe(200)
    expect(await holders(token)).toEqual([a.id])

    expect((await b.register(token)).status).toBe(200)
    expect(await holders(token)).toEqual([b.id])
  })

  it("sends the first account's pushes nowhere after the move, not to the second person's phone", async () => {
    const [a, b] = [await person("pt-push-a"), await person("pt-push-b")]
    await db.profiles.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { push_enabled: true } })
    const token = newToken()
    const pushToA = () => sendPushNotification({ userId: a.id, title: "A's DM", body: "private", data: { type: "event_update" } })
    const reached = () => sent.mock.calls.flatMap(([m]) => m.map((x) => x.to))

    await a.register(token)
    await pushToA()
    expect(reached()).toContain(token) // the control: while A holds it, A's pushes reach it

    sent.mockClear()
    await b.register(token)
    await pushToA()
    expect(reached()).not.toContain(token)
  })

  it("keeps one row when the same account registers it again, and moves its time", async () => {
    const a = await person("pt-same")
    const token = newToken()
    await a.register(token)
    const first = await db.push_tokens.findFirstOrThrow({ where: { token } })
    await new Promise((r) => setTimeout(r, 15))
    expect((await a.register(token)).status).toBe(200)
    const rows = await db.push_tokens.findMany({ where: { token } })
    expect(rows).toHaveLength(1)
    expect(rows[0].updated_at.getTime()).toBeGreaterThan(first.updated_at.getTime())
  })

  it("settles on exactly one holder when two accounts register the same token at once, with no 500", async () => {
    const [a, b] = [await person("pt-race-a"), await person("pt-race-b")]
    const token = newToken()
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).register(token)))
    expect(results.map((r) => r.status)).toEqual(Array(12).fill(200))
    const who = await holders(token)
    expect(who).toHaveLength(1)
    expect([a.id, b.id]).toContain(who[0])
  })

  it("follows the platform the device now reports", async () => {
    const a = await person("pt-plat")
    const token = newToken()
    await a.register(token, "ios")
    await a.register(token, "android")
    expect((await db.push_tokens.findFirstOrThrow({ where: { token } })).platform).toBe("android")
  })

  it("still keeps only an account's three most recent tokens per platform", async () => {
    const a = await person("pt-prune")
    const tokens = [newToken(), newToken(), newToken(), newToken()]
    for (const t of tokens) {
      await a.register(t)
      await new Promise((r) => setTimeout(r, 10))
    }
    const kept = (await db.push_tokens.findMany({ where: { user_id: a.id } })).map((r) => r.token).sort()
    expect(kept).toEqual(tokens.slice(1).sort())
  })

  it("prunes only the registering account's own rows, never another account's", async () => {
    const [a, bystander] = [await person("pt-prune-a"), await person("pt-prune-by")]
    const theirs = newToken()
    await bystander.register(theirs)
    for (let i = 0; i < 5; i++) {
      await a.register(newToken())
      await new Promise((r) => setTimeout(r, 8))
    }
    expect(await db.push_tokens.count({ where: { user_id: a.id } })).toBe(3)
    expect(await holders(theirs)).toEqual([bystander.id])
  })

  it("lets one account's sign-out DELETE remove only its own row", async () => {
    const [a, b] = [await person("pt-del-a"), await person("pt-del-b")]
    const token = newToken()
    await a.register(token)
    await b.register(token)
    expect((await a.remove(token)).status).toBe(200)
    expect(await holders(token)).toEqual([b.id])
  })
})

describe("what may be registered, and what a move costs (SCRUM-668 review)", () => {
  it.each(["not-a-token", "ExponentPushToken", "ExponentPushToken[]", "fcm:APA91bH...", " ExponentPushToken[abc] ", "ExponentPushToken[" + "a".repeat(300) + "]"])(
    "refuses %p: only an Expo push token is registered",
    async (bad) => {
      const a = await person("pt-bad")
      expect((await a.register(bad)).status).toBe(400)
      expect(await db.push_tokens.count({ where: { user_id: a.id } })).toBe(0)
    }
  )

  it("accepts both spellings Expo issues", async () => {
    const a = await person("pt-spell")
    for (const token of [`ExponentPushToken[${testId("x")}]`, `ExpoPushToken[${testId("y")}]`]) {
      expect((await a.register(token)).status).toBe(200)
    }
  })

  it("logs a move with the old and new account and the platform, never the token", async () => {
    const [a, b] = [await person("pt-log-a"), await person("pt-log-b")]
    const token = newToken()
    await a.register(token, "ios")
    const info = jest.spyOn(logger, "info").mockImplementation(() => undefined)
    try {
      await b.register(token, "android")
      const line = info.mock.calls.find(([m]) => /moved/i.test(m))
      expect(line).toBeDefined()
      expect(line![1]).toMatchObject({ fromUserId: a.id, toUserId: b.id, platform: "android" })
      expect(JSON.stringify(info.mock.calls)).not.toContain(token)
    } finally {
      info.mockRestore()
    }
  })

  it("does not log a move when the same account registers its own token again, or a new token", async () => {
    const a = await person("pt-nolog")
    const token = newToken()
    const info = jest.spyOn(logger, "info").mockImplementation(() => undefined)
    try {
      await a.register(token)
      await a.register(token)
      await a.register(newToken())
      expect(info.mock.calls.filter(([m]) => /moved/i.test(m))).toHaveLength(0)
    } finally {
      info.mockRestore()
    }
  })

  it("limits how many tokens one account may take over from others in an hour", async () => {
    const taker = await person("pt-taker")
    const victims = await Promise.all(Array.from({ length: MAX_TOKEN_MOVES_PER_HOUR + 2 }, (_, i) => person(`pt-vic-${i}`)))
    const tokens = victims.map(() => newToken())
    for (const [i, v] of victims.entries()) await v.register(tokens[i])

    const statuses: number[] = []
    for (const t of tokens) statuses.push((await taker.register(t)).status)
    expect(statuses.slice(0, MAX_TOKEN_MOVES_PER_HOUR)).toEqual(Array(MAX_TOKEN_MOVES_PER_HOUR).fill(200))
    expect(statuses.slice(MAX_TOKEN_MOVES_PER_HOUR)).toEqual([429, 429])
    // The refused ones stayed with their holders.
    for (const [i, v] of victims.entries()) {
      if (i >= MAX_TOKEN_MOVES_PER_HOUR) expect(await holders(tokens[i])).toEqual([v.id])
    }
  })

  it("counts only moves: registering new tokens and re-registering one's own is unlimited", async () => {
    const a = await person("pt-free")
    const own = newToken()
    const statuses = [(await a.register(own)).status]
    for (let i = 0; i < MAX_TOKEN_MOVES_PER_HOUR + 3; i++) statuses.push((await a.register(own)).status)
    expect(statuses.every((x) => x === 200)).toBe(true)
  })
})
