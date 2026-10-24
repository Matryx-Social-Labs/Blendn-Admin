import { NextRequest } from "next/server"

process.env.MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET ?? "itest-mobile-secret-0123456789abcdefghij"
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { signAccessToken } from "@/lib/mobile-auth"
import { db, closeDb, makeUser, testId } from "./helpers"

/*
 * API M3 (security audit): a push token belonged to nobody in particular. When
 * Alice's sign-out never reached the server, Bob registering the same phone's
 * token left Alice's row live, and her DM pushes kept arriving on Bob's phone.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const route = require("@/app/api/mobile/notifications/token/route") as typeof import("@/app/api/mobile/notifications/token/route")

const users: string[] = []
afterAll(async () => {
  await db.push_tokens.deleteMany({ where: { user_id: { in: users } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

async function person(label: string) {
  const id = await makeUser(testId(label))
  users.push(id)
  const { email } = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
  return { id, token: signAccessToken(id, email) }
}

const register = (bearer: string, token: string) =>
  route.POST(
    new NextRequest("http://localhost/api/mobile/notifications/token", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ token, platform: "ios" }),
    })
  )

it("moves a push token to the account that registers it last", async () => {
  const alice = await person("pt_a")
  const bob = await person("pt_b")
  const phone = `ExponentPushToken[${testId("phone")}]`

  expect((await register(alice.token, phone)).status).toBe(200)
  expect((await register(bob.token, phone)).status).toBe(200)

  const owners = await db.push_tokens.findMany({ where: { token: phone }, select: { user_id: true } })
  expect(owners).toEqual([{ user_id: bob.id }])
})
