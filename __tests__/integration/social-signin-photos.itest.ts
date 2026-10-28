/*
 * A social sign-in answers with the profile's photos (SCRUM-787): Me draws the
 * photo from the sign-in response, and the Google and Apple routes selected no
 * `photos`, so Me had none until the session was re-read.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/mobile-auth", () => ({
  ...jest.requireActual("@/lib/mobile-auth"),
  verifyGoogleIdToken: jest.fn(),
  verifyAppleIdToken: jest.fn(),
}))

import { NextRequest } from "next/server"

import { verifyAppleIdToken, verifyGoogleIdToken } from "@/lib/mobile-auth"
import { resetMemoryStore } from "@/lib/rate-limit-store"
import { cleanup, closeDb, db, makeUser, onboard, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const googleRoute = require("@/app/api/mobile/auth/google/route") as typeof import("@/app/api/mobile/auth/google/route")
const appleRoute = require("@/app/api/mobile/auth/apple/route") as typeof import("@/app/api/mobile/auth/apple/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const users: string[] = []
const PHOTOS = ["https://cdn.itest.invalid/me-1.jpg", "https://cdn.itest.invalid/me-2.jpg"]

beforeEach(() => resetMemoryStore())
afterAll(async () => {
  await db.mobile_refresh_tokens.deleteMany({ where: { user_id: { in: users } } })
  await cleanup(users, [])
  await closeDb()
})

const post = (path: string, body: unknown) =>
  new NextRequest(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

async function account(label: string) {
  const id = await makeUser(testId(label))
  users.push(id)
  await onboard(id)
  await db.profiles.update({ where: { id }, data: { photos: PHOTOS } })
  const googleId = testId("g")
  const appleId = testId("a")
  await db.user_oauth_accounts.createMany({
    data: [
      { user_id: id, provider: "google", provider_id: googleId },
      { user_id: id, provider: "apple", provider_id: appleId },
    ],
  })
  const { email } = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
  return { email, googleId, appleId }
}

it("Google sign-in carries profile.photos", async () => {
  const a = await account("sp-g")
  jest.mocked(verifyGoogleIdToken).mockResolvedValue({ sub: a.googleId, email: a.email } as never)
  const res = await googleRoute.POST(post("/api/mobile/auth/google", { idToken: "t" }))
  expect(res.status).toBe(200)
  expect((await res.json()).data.user.profile.photos).toEqual(PHOTOS)
})

it("Apple sign-in carries profile.photos", async () => {
  const a = await account("sp-a")
  jest.mocked(verifyAppleIdToken).mockResolvedValue({ sub: a.appleId, email: a.email } as never)
  const res = await appleRoute.POST(post("/api/mobile/auth/apple", { identityToken: "t" }))
  expect(res.status).toBe(200)
  expect((await res.json()).data.user.profile.photos).toEqual(PHOTOS)
})
