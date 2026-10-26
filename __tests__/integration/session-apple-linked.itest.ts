import { NextRequest } from "next/server"

/*
 * `GET /auth/session` says whether Sign in with Apple is linked, apart from
 * `signInMethod`: an account made with Apple that later set a password reads
 * `password`, and the app skipped the Apple step on delete, so the grant was
 * never revoked (5.1.1(v)).
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
import { signAccessToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeUser, onboard, testId } from "./helpers"
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sessionRoute = require("@/app/api/mobile/auth/session/route") as typeof import("@/app/api/mobile/auth/session/route")

const users: string[] = []

afterAll(async () => {
  await cleanup(users, [])
  await closeDb()
})

async function account(opts: { password: boolean; apple: boolean; google?: boolean }) {
  const id = await makeUser("sess-apple")
  users.push(id)
  await onboard(id)
  if (opts.password) await db.user.update({ where: { id }, data: { password: "$2a$12$not.a.real.hash.but.present" } })
  if (opts.apple) await db.user_oauth_accounts.create({ data: { user_id: id, provider: "apple", provider_id: testId("apple") } })
  if (opts.google) await db.user_oauth_accounts.create({ data: { user_id: id, provider: "google", provider_id: testId("google") } })
  return id
}

async function session(userId: string) {
  const res = await sessionRoute.GET(
    new NextRequest("http://localhost/api/mobile/auth/session", {
      headers: { authorization: `Bearer ${signAccessToken(userId, `${userId}@itest.invalid`)}` },
    })
  )
  expect(res.status).toBe(200)
  return (await res.json()).data as { signInMethod: string; appleLinked: boolean }
}

it("an Apple account that later set a password reads password, and appleLinked", async () => {
  expect(await session(await account({ password: true, apple: true }))).toMatchObject({ signInMethod: "password", appleLinked: true })
})

it("an Apple-only account reads apple, and appleLinked", async () => {
  expect(await session(await account({ password: false, apple: true }))).toMatchObject({ signInMethod: "apple", appleLinked: true })
})

it("a password or Google account is not appleLinked", async () => {
  expect(await session(await account({ password: true, apple: false }))).toMatchObject({ appleLinked: false })
  expect(await session(await account({ password: false, apple: false, google: true }))).toMatchObject({ signInMethod: "google", appleLinked: false })
})
