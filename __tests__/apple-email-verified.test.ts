const mockJwtVerify = jest.fn()
jest.mock("jose", () => ({ jwtVerify: (...a: unknown[]) => mockJwtVerify(...a), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/db", () => ({ db: {} }))
jest.mock("@/lib/logger", () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }))

import { verifyAppleIdToken } from "@/lib/mobile-auth"

/*
 * SCRUM-946. An Apple token's email becomes the account's email, and an
 * existing account with that email is linked to it. Google's path already
 * refuses an unverified address; Apple's did not look.
 */
const verify = (claims: Record<string, unknown>) => {
  mockJwtVerify.mockResolvedValueOnce({ payload: { sub: "001.a", ...claims } })
  return verifyAppleIdToken("t")
}

describe("verifyAppleIdToken email_verified", () => {
  it.each([true, "true"])("accepts a verified address (%p)", async (v) => {
    expect(await verify({ email: "a@b.test", email_verified: v })).not.toBeNull()
  })
  it.each([false, "false", undefined])("refuses an address that is not verified (%p)", async (v) => {
    expect(await verify({ email: "a@b.test", email_verified: v })).toBeNull()
  })
  it("accepts a token with no email at all (a returning user; sub is the identity)", async () => {
    expect(await verify({})).not.toBeNull()
  })
})
