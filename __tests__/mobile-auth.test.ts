process.env.MOBILE_JWT_SECRET = "test-secret-at-least-32-characters-long!!"

// `jose` ships ESM-only and ts-jest can't transform it. It's only reached by
// Apple ID token verification, which these tests don't exercise.
jest.mock("jose", () => ({
  jwtVerify: jest.fn(),
  createRemoteJWKSet: jest.fn(),
}))

jest.mock("@/lib/db", () => ({
  db: {
    mobile_refresh_tokens: {
      create: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
  },
}))

import jwt from "jsonwebtoken"
import {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  extractBearerToken,
} from "@/lib/mobile-auth"

const USER = "user_abc"
const EMAIL = "user@example.com"

describe("signAccessToken / verifyAccessToken", () => {
  it("round-trips the user identity", () => {
    const decoded = verifyAccessToken(signAccessToken(USER, EMAIL))

    expect(decoded).not.toBeNull()
    expect(decoded!.userId).toBe(USER)
    expect(decoded!.email).toBe(EMAIL)
    expect(decoded!.type).toBe("access")
  })

  it("issues access tokens with a 15-minute lifetime", () => {
    const decoded = verifyAccessToken(signAccessToken(USER, EMAIL))!
    expect(decoded.exp! - decoded.iat!).toBe(15 * 60)
  })

  it("rejects a refresh token presented as an access token", () => {
    // Type confusion: a 30-day refresh token must not be usable as a 15-minute
    // access credential just because both are signed with the same secret.
    expect(verifyAccessToken(signRefreshToken(USER, EMAIL))).toBeNull()
  })

  it("rejects a token signed with a different secret", () => {
    const forged = jwt.sign({ userId: USER, email: EMAIL, type: "access" }, "wrong-secret")
    expect(verifyAccessToken(forged)).toBeNull()
  })

  it("rejects a tampered payload", () => {
    const [header, , signature] = signAccessToken(USER, EMAIL).split(".")
    const forgedPayload = Buffer.from(
      JSON.stringify({ userId: "attacker", email: EMAIL, type: "access" })
    ).toString("base64url")

    expect(verifyAccessToken(`${header}.${forgedPayload}.${signature}`)).toBeNull()
  })

  it("rejects an expired token", () => {
    const expired = jwt.sign(
      { userId: USER, email: EMAIL, type: "access" },
      process.env.MOBILE_JWT_SECRET!,
      { expiresIn: "-1s" }
    )
    expect(verifyAccessToken(expired)).toBeNull()
  })

  it("rejects garbage without throwing", () => {
    expect(verifyAccessToken("not-a-jwt")).toBeNull()
    expect(verifyAccessToken("")).toBeNull()
  })
})

describe("signRefreshToken", () => {
  it("carries a jti so the token can be tracked and revoked in the DB", () => {
    // storeRefreshToken uses this jti as the mobile_refresh_tokens row id;
    // without it, rotation and revocation have nothing to key on.
    const decoded = jwt.decode(signRefreshToken(USER, EMAIL)) as Record<string, unknown>
    expect(decoded.jti).toEqual(expect.any(String))
    expect(decoded.type).toBe("refresh")
  })

  it("issues a distinct jti per token so rotation is traceable", () => {
    const a = jwt.decode(signRefreshToken(USER, EMAIL)) as Record<string, unknown>
    const b = jwt.decode(signRefreshToken(USER, EMAIL)) as Record<string, unknown>
    expect(a.jti).not.toBe(b.jti)
  })

  it("issues refresh tokens with a 30-day lifetime", () => {
    const decoded = jwt.decode(signRefreshToken(USER, EMAIL)) as Record<string, number>
    expect(decoded.exp - decoded.iat).toBe(30 * 24 * 60 * 60)
  })
})

describe("extractBearerToken", () => {
  it("pulls the token out of a well-formed header", () => {
    expect(extractBearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi")
  })

  it("returns null for a missing or malformed header", () => {
    expect(extractBearerToken(null)).toBeNull()
    expect(extractBearerToken("")).toBeNull()
    expect(extractBearerToken("abc.def.ghi")).toBeNull()
    expect(extractBearerToken("Basic abc")).toBeNull()
  })

  it("is case-sensitive on the scheme", () => {
    expect(extractBearerToken("bearer abc")).toBeNull()
  })
})
