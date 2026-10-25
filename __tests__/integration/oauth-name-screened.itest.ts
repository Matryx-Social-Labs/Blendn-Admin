/*
 * The name a new Sign in with Apple or Google account is created with is
 * capped and screened (PR #755 review, M2). A refused name makes the account
 * anyway, with no name, and onboarding asks for one. Real rows; the token
 * verification is upstream of these helpers and not what is under test.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
import { findOrCreateAppleUser, findOrCreateGoogleUser, type AppleTokenPayload, type GoogleTokenPayload } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, testId } from "./helpers"

const users: string[] = []

afterAll(async () => {
  await cleanup(users, [])
  await closeDb()
})

const apple = (label: string) => ({ sub: testId(label), email: `${testId(label)}@itest.invalid` }) as unknown as AppleTokenPayload
const google = (label: string, name: string) =>
  ({ sub: testId(label), email: `${testId(label)}@itest.invalid`, email_verified: true, name }) as unknown as GoogleTokenPayload

async function names(userId: string) {
  users.push(userId)
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true, profile: { select: { name: true } } } })
  return [user.name, user.profile?.name]
}

it("Apple: a slur as fullName still signs in, with no name", async () => {
  const { userId, isNewUser } = await findOrCreateAppleUser(apple("ap-slur"), { givenName: "Retard", familyName: "McGee" })
  expect(isNewUser).toBe(true)
  expect(await names(userId)).toEqual([null, null])
})

it("Apple: a 300-character fullName is capped at 64", async () => {
  const { userId } = await findOrCreateAppleUser(apple("ap-long"), { givenName: "A".repeat(300), familyName: null })
  expect(await names(userId)).toEqual(["A".repeat(64), "A".repeat(64)])
})

it("Apple: a real name the chat list would hide is kept", async () => {
  const { userId } = await findOrCreateAppleUser(apple("ap-real"), { givenName: "Bal", familyName: "Krishna" })
  expect(await names(userId)).toEqual(["Bal Krishna", "Bal Krishna"])
})

it("Google: the same cap and screen", async () => {
  const slur = await findOrCreateGoogleUser(google("go-slur", "Retard McGee"))
  expect(await names(slur.userId)).toEqual([null, null])
  const long = await findOrCreateGoogleUser(google("go-long", "B".repeat(100)))
  expect(await names(long.userId)).toEqual(["B".repeat(64), "B".repeat(64)])
})
