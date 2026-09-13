import { NextRequest } from "next/server"

/*
 * A refresh whose response never reached the phone.
 *
 * The route rotates before the client stores the new pair, so a refresh that
 * times out on the client leaves the server holding a token nobody has and
 * the phone holding a token that is dead. Driven on an emulator: one 15s
 * timeout on a slow dev route and the session was gone thirty minutes in.
 * Replaying the old token inside the grace window must be answered with a
 * fresh pair, and the pair nobody received must stop working.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import jwt from "jsonwebtoken"
import { signRefreshToken, storeRefreshToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeUser } from "./helpers"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const route = require("@/app/api/mobile/auth/refresh/route") as typeof import("@/app/api/mobile/auth/refresh/route")

const users: string[] = []

afterAll(async () => {
  await cleanup(users, [])
  await closeDb()
})

const refresh = (refreshToken: string) =>
  route.POST(
    new NextRequest("http://localhost/api/mobile/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    })
  )

const jti = (token: string) => (jwt.decode(token) as { jti: string }).jti

it("re-issues on a replay inside the grace window and retires the pair nobody got", async () => {
  const userId = await makeUser("rr-a")
  users.push(userId)
  const { email } = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } })
  const first = signRefreshToken(userId, email)
  await storeRefreshToken(userId, first)

  // The rotation the phone never heard back from.
  const lost = await refresh(first)
  expect(lost.status).toBe(200)
  const lostPair = ((await lost.json()) as { data: { refreshToken: string } }).data
  const oldRow = await db.mobile_refresh_tokens.findUniqueOrThrow({ where: { id: jti(first) } })
  expect(oldRow.revoked_at).not.toBeNull()
  expect(oldRow.replaced_by).toBe(jti(lostPair.refreshToken))

  // The phone retries with what it still holds.
  const retry = await refresh(first)
  expect(retry.status).toBe(200)
  const retryPair = ((await retry.json()) as { data: { refreshToken: string } }).data

  // The orphan is dead, the retry's pair is live, and it is the only live one.
  const succ = await db.mobile_refresh_tokens.findUniqueOrThrow({ where: { id: jti(lostPair.refreshToken) } })
  expect(succ.revoked_at).not.toBeNull()
  const live = await db.mobile_refresh_tokens.findMany({ where: { user_id: userId, revoked_at: null } })
  expect(live.map((r) => r.id)).toEqual([jti(retryPair.refreshToken)])

  // And the orphan, presented later, is refused.
  expect((await refresh(lostPair.refreshToken)).status).toBe(401)
})

it("still ends the family on a replay long after rotation", async () => {
  const userId = await makeUser("rr-b")
  users.push(userId)
  const { email } = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } })
  const first = signRefreshToken(userId, email)
  await storeRefreshToken(userId, first)
  const pair = ((await (await refresh(first)).json()) as { data: { refreshToken: string } }).data

  await db.mobile_refresh_tokens.update({
    where: { id: jti(first) },
    data: { revoked_at: new Date(Date.now() - 10 * 60_000) },
  })
  expect((await refresh(first)).status).toBe(401)
  // Reuse detection: the legitimate successor is gone too.
  expect((await refresh(pair.refreshToken)).status).toBe(401)
})
