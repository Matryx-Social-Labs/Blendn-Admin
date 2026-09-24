import { NextRequest } from "next/server"

/*
 * SCRUM-290. A suspended person was told "You were signed out", never why.
 *
 * Suspension revokes every refresh token, and the refresh route refused a
 * revoked token with 401 before it ever reached its suspended check — so the
 * 403 "This account has been suspended…" that the phone knows how to show
 * (Blendn #268) could not be produced by a real suspension. Driven on staging:
 * suspended 14:52:40, the phone's refresh at 14:53:23 got 401.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import jwt from "jsonwebtoken"
import { signRefreshToken, storeRefreshToken, SUSPENDED_MESSAGE } from "@/lib/mobile-auth"
import { applySuspension } from "@/lib/suspension"
import { cleanup, closeDb, db, makeUser } from "./helpers"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const route = require("@/app/api/mobile/auth/refresh/route") as typeof import("@/app/api/mobile/auth/refresh/route")

const users: string[] = []

afterAll(async () => {
  await cleanup(users, [])
  await closeDb()
})

const refresh = async (refreshToken: string) => {
  const res = await route.POST(
    new NextRequest("http://localhost/api/mobile/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    })
  )
  return { status: res.status, body: (await res.json()) as { error?: string; data?: unknown } }
}

async function signedIn(label: string, role: "attendee" | "organizer" = "attendee") {
  const userId = await makeUser(label, role)
  users.push(userId)
  const { email } = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } })
  const token = signRefreshToken(userId, email)
  await storeRefreshToken(userId, token)
  return { userId, token }
}

it("tells a suspended person why, with the token the suspension revoked", async () => {
  const { userId, token } = await signedIn("ras-suspended")
  const admin = await makeUser("ras-admin", "app_admin")
  users.push(admin)
  await db.$transaction((tx) => applySuspension(tx, userId, admin))
  expect(await db.mobile_refresh_tokens.count({ where: { user_id: userId, revoked_at: null } })).toBe(0)

  const res = await refresh(token)
  expect(res.status).toBe(403)
  expect(res.body.error).toBe(SUSPENDED_MESSAGE)
  expect(res.body.data).toBeUndefined()
})

it("says nothing for a token revoked before the suspension", async () => {
  // Signed out last week, suspended today: that old token was not a session
  // the suspension ended, so it must not become an oracle for the account's
  // standing for the rest of its 30 days.
  const { userId, token } = await signedIn("ras-earlier")
  await db.mobile_refresh_tokens.updateMany({
    where: { user_id: userId },
    data: { revoked_at: new Date(Date.now() - 7 * 86_400_000) },
  })
  const admin = await makeUser("ras-admin-3", "app_admin")
  users.push(admin)
  await db.$transaction((tx) => applySuspension(tx, userId, admin))

  expect((await refresh(token)).status).toBe(401)
})

it("says nothing about a staff role to a revoked token", async () => {
  // A live staff token is refused with the staff sentence on the normal path;
  // a dead one learns nothing.
  const { userId, token } = await signedIn("ras-staff")
  await db.user.update({ where: { id: userId }, data: { role: "organizer" } })
  await db.mobile_refresh_tokens.updateMany({ where: { user_id: userId }, data: { revoked_at: new Date() } })

  expect((await refresh(token)).status).toBe(401)
})

it("still answers 401 for a revoked token of an account in good standing", async () => {
  // Sign-out revokes too; that person is not suspended and must not be told so.
  const { userId, token } = await signedIn("ras-signedout")
  await db.mobile_refresh_tokens.updateMany({ where: { user_id: userId }, data: { revoked_at: new Date() } })

  const res = await refresh(token)
  expect(res.status).toBe(401)
})

it("says nothing about an account to a token that is not ours or has expired", async () => {
  const { userId } = await signedIn("ras-forged")
  const admin = await makeUser("ras-admin-2", "app_admin")
  users.push(admin)
  await db.$transaction((tx) => applySuspension(tx, userId, admin))

  // Same claims, wrong key: whose account it names must not be revealed.
  const forged = jwt.sign({ userId, email: "x@y.z", type: "refresh", jti: "f" }, "not-the-secret-not-the-secret-000")
  expect((await refresh(forged)).status).toBe(401)

  // Right key, expired: nothing either.
  const secret = process.env.MOBILE_JWT_SECRET as string
  const expired = jwt.sign({ userId, email: "x@y.z", type: "refresh", jti: "e", exp: Math.floor(Date.now() / 1000) - 60 }, secret)
  expect((await refresh(expired)).status).toBe(401)
})

it("still refuses a live token of a suspended account with the sentence (the route's own check)", async () => {
  // Not how suspension works today (it revokes), but it is the route's
  // boundary if a token ever survives one.
  const { userId, token } = await signedIn("ras-live")
  const admin = await makeUser("ras-admin-4", "app_admin")
  users.push(admin)
  await db.user.update({ where: { id: userId }, data: { suspended_at: new Date(), suspended_by: admin } })

  const res = await refresh(token)
  expect(res.status).toBe(403)
  expect(res.body.error).toBe(SUSPENDED_MESSAGE)
})

it("does not confirm a deleted account, even one the suspension revoked", async () => {
  const { userId, token } = await signedIn("ras-deleted")
  const admin = await makeUser("ras-admin-5", "app_admin")
  users.push(admin)
  await db.$transaction((tx) => applySuspension(tx, userId, admin))
  await db.user.update({ where: { id: userId }, data: { deletedAt: new Date() } })

  expect((await refresh(token)).status).toBe(401)
})
