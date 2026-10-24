import { NextRequest } from "next/server"
import bcrypt from "bcryptjs"

/*
 * Linking Google/Apple to an unverified password account ends the squatter's
 * phone sessions (security audit 2026-10-24, API H1).
 *
 * `linkVerifiedOAuthIdentity` dropped the squatter's password and nothing else:
 * their refresh token still rotated for thirty days and their push token kept
 * receiving the victim's DM previews. Real link, real tokens, the real refresh
 * route.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { findOrCreateAppleUser, findOrCreateGoogleUser, signRefreshToken, storeRefreshToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, testId } from "./helpers"
// eslint-disable-next-line @typescript-eslint/no-require-imports
const refreshRoute = require("@/app/api/mobile/auth/refresh/route") as typeof import("@/app/api/mobile/auth/refresh/route")

const users: string[] = []
afterAll(async () => {
  await db.user_oauth_accounts.deleteMany({ where: { user_id: { in: users } } })
  await cleanup(users, [])
  await closeDb()
})

const refresh = (refreshToken: string) =>
  refreshRoute.POST(
    new NextRequest("http://localhost/api/mobile/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": `10.77.0.${Math.floor(Math.random() * 250)}` },
      body: JSON.stringify({ refreshToken }),
    })
  )

/** An unverified password signup with a phone signed in and registered for push. */
async function squatter(emailVerified: Date | null) {
  const id = testId("squat")
  const email = `${id}@itest.invalid`
  await db.user.create({
    data: { id, email, name: "Squatter", role: "attendee", password: await bcrypt.hash("attacker-chosen-1", 4), emailVerified },
  })
  users.push(id)
  const token = signRefreshToken(id, email)
  await storeRefreshToken(id, token)
  await db.push_tokens.create({ data: { user_id: id, token: `ExponentPushToken[${id}]`, platform: "ios" } })
  return { id, email, token }
}

const google = (email: string) =>
  findOrCreateGoogleUser({ sub: testId("gsub"), email, email_verified: true, aud: "a", iss: "i", exp: 0, iat: 0 })

it("ends the squatter's phone session and push registration when Google links to their unverified account", async () => {
  const { id, email, token } = await squatter(null)
  await google(email)

  const row = await db.user.findUniqueOrThrow({ where: { id }, select: { password: true, emailVerified: true, mobile_sessions_revoked_at: true } })
  expect(row.password).toBeNull()
  expect(row.emailVerified).not.toBeNull()
  expect(row.mobile_sessions_revoked_at).not.toBeNull()
  expect(await db.push_tokens.count({ where: { user_id: id } })).toBe(0)
  const tokens = await db.mobile_refresh_tokens.findMany({ where: { user_id: id }, select: { revoked_at: true, revoked_reason: true } })
  expect(tokens.length).toBeGreaterThan(0)
  expect(tokens.every((t) => t.revoked_at && t.revoked_reason === "password_reset")).toBe(true)

  const res = await refresh(token)
  expect(res.status).toBe(401)
  expect(((await res.json()) as { errorCode?: string }).errorCode).toBe("PASSWORD_RESET")
})

it("does the same for Apple", async () => {
  const { id, email } = await squatter(null)
  await findOrCreateAppleUser({ sub: testId("asub"), email, aud: "a", iss: "i", exp: 0, iat: 0 })
  expect(await db.push_tokens.count({ where: { user_id: id } })).toBe(0)
  expect(await db.mobile_refresh_tokens.count({ where: { user_id: id, revoked_at: null } })).toBe(0)
})

it("leaves a verified account's sessions alone: its owner proved the address, so the link is ordinary", async () => {
  const { id, email, token } = await squatter(new Date())
  await google(email)
  expect(await db.push_tokens.count({ where: { user_id: id } })).toBe(1)
  expect(await db.mobile_refresh_tokens.count({ where: { user_id: id, revoked_at: null } })).toBe(1)
  expect((await refresh(token)).status).toBe(200)
})
