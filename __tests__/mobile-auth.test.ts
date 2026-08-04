process.env.MOBILE_JWT_SECRET = "test-secret-at-least-32-characters-long!!"

// `jose` ships ESM-only and ts-jest can't transform it. It's only reached by
// Apple ID token verification, which these tests don't exercise.
jest.mock("jose", () => ({
  jwtVerify: jest.fn(),
  createRemoteJWKSet: jest.fn(),
}))

const mockDb = {
  mobile_refresh_tokens: {
    create: jest.fn(),
    findUnique: jest.fn(),
    updateMany: jest.fn(),
  },
}

jest.mock("@/lib/db", () => ({ db: mockDb }))

import jwt from "jsonwebtoken"
import {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  storeRefreshToken,
  extractBearerToken,
} from "@/lib/mobile-auth"

const USER = "user_abc"
const EMAIL = "user@example.com"

beforeEach(() => {
  jest.clearAllMocks()
})

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

describe("storeRefreshToken", () => {
  it("refuses to store a token with no jti instead of writing undefined as the row id", async () => {
    const noJti = jwt.sign(
      { userId: USER, email: EMAIL, type: "refresh" },
      process.env.MOBILE_JWT_SECRET!
    )
    await expect(storeRefreshToken(USER, noJti)).rejects.toThrow(/jti/)
    expect(mockDb.mobile_refresh_tokens.create).not.toHaveBeenCalled()
  })

  it("keys the row on the token's jti so rotation can find it", async () => {
    const token = signRefreshToken(USER, EMAIL)
    const { jti } = jwt.decode(token) as { jti: string }

    await storeRefreshToken(USER, token)

    expect(mockDb.mobile_refresh_tokens.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ id: jti, user_id: USER }),
      })
    )
  })
})

describe("verifyRefreshToken — reuse handling", () => {
  const withStoredToken = (overrides: Record<string, unknown>) => {
    const token = signRefreshToken(USER, EMAIL)
    const { jti } = jwt.decode(token) as { jti: string }
    mockDb.mobile_refresh_tokens.findUnique.mockResolvedValue({
      id: jti,
      user_id: USER,
      token_hash: "$2a$04$notarealhash",
      expires_at: new Date(Date.now() + 60_000),
      revoked_at: null,
      ...overrides,
    })
    return token
  }

  it("rejects an unknown token", async () => {
    mockDb.mobile_refresh_tokens.findUnique.mockResolvedValue(null)
    await expect(verifyRefreshToken(signRefreshToken(USER, EMAIL))).resolves.toBeNull()
  })

  it("rejects a token replayed seconds after rotation WITHOUT nuking every session", async () => {
    // The refresh route revokes the old token before the client has stored the
    // new one. An app killed mid-refresh replays the old token on next launch —
    // that is recovery, not theft. Revoking the family here would sign the user
    // out on every device they own.
    const token = withStoredToken({ revoked_at: new Date(Date.now() - 5_000) })

    await expect(verifyRefreshToken(token)).resolves.toBeNull()
    expect(mockDb.mobile_refresh_tokens.updateMany).not.toHaveBeenCalled()
  })

  it("revokes the whole family when a token is replayed long after rotation", async () => {
    const token = withStoredToken({ revoked_at: new Date(Date.now() - 10 * 60_000) })

    await expect(verifyRefreshToken(token)).resolves.toBeNull()
    expect(mockDb.mobile_refresh_tokens.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { user_id: USER, revoked_at: null },
        data: { revoked_at: expect.any(Date) },
      })
    )
  })

  it("rejects a DB-expired token", async () => {
    const token = withStoredToken({ expires_at: new Date(Date.now() - 1_000) })
    await expect(verifyRefreshToken(token)).resolves.toBeNull()
    expect(mockDb.mobile_refresh_tokens.updateMany).not.toHaveBeenCalled()
  })

  it("rejects an access token presented as a refresh token", async () => {
    await expect(verifyRefreshToken(signAccessToken(USER, EMAIL))).resolves.toBeNull()
    expect(mockDb.mobile_refresh_tokens.findUnique).not.toHaveBeenCalled()
  })
})
