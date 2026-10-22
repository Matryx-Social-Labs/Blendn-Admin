process.env.MOBILE_JWT_SECRET = "test-secret-at-least-32-characters-long!!"
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/db", () => ({ db: {} }))

import { signInMethodOf } from "@/lib/mobile-auth"

const accounts = (...providers: string[]) => providers.map((provider) => ({ provider }))

describe("signInMethodOf", () => {
  it("is the password when the account has one, whatever is linked", () => {
    expect(signInMethodOf({ password: "hash", oauth_accounts: accounts("google", "apple") })).toBe("password")
  })

  it("is the provider linked most recently (the list is newest first) when there is no password", () => {
    expect(signInMethodOf({ password: null, oauth_accounts: accounts("apple", "google") })).toBe("apple")
    expect(signInMethodOf({ password: null, oauth_accounts: accounts("google", "apple") })).toBe("google")
  })

  it("falls back to password for an account with neither (it has the one a reset link would fix)", () => {
    expect(signInMethodOf({ password: null, oauth_accounts: [] })).toBe("password")
  })

  it("falls back to password for a provider the app does not know, never echoing it", () => {
    expect(signInMethodOf({ password: null, oauth_accounts: accounts("github") })).toBe("password")
  })

  it("treats an empty password as none", () => {
    expect(signInMethodOf({ password: "", oauth_accounts: accounts("google") })).toBe("google")
  })
})
