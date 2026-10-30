process.env.MOBILE_JWT_SECRET = "test-secret-at-least-32-characters-long!!"
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

const mockDb = { mobile_refresh_tokens: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) } }
jest.mock("@/lib/db", () => ({ db: mockDb }))

import jwt from "jsonwebtoken"
import { NextRequest } from "next/server"
import { revokeRefreshToken } from "@/lib/mobile-auth"
import { GET as probe } from "@/app/api/health/sentry-probe/route"

/*
 * SCRUM-941. Sign-out decodes a client-supplied token WITHOUT verifying it, so
 * its `jti` can be any JSON value; an object reaches `updateMany` as a filter
 * (`{ not: x }` is "every token of this user"). Scoped by `user_id`, so it is
 * self-harm, but a revoke must name one token.
 */
describe("revokeRefreshToken", () => {
  beforeEach(() => mockDb.mobile_refresh_tokens.updateMany.mockClear())
  const unsigned = (jti: unknown) => jwt.sign({ jti }, "any-secret-of-sufficient-length-here")

  it("revokes the one token a string jti names, scoped to the caller", async () => {
    await revokeRefreshToken(unsigned("11111111-1111-4111-8111-111111111111"), undefined, "u1")
    expect(mockDb.mobile_refresh_tokens.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "11111111-1111-4111-8111-111111111111", revoked_at: null, user_id: "u1" } })
    )
  })

  it("does nothing for a jti that is not a string", async () => {
    for (const jti of [{ not: "x" }, ["a"], 7, true]) await revokeRefreshToken(unsigned(jti), undefined, "u1")
    expect(mockDb.mobile_refresh_tokens.updateMany).not.toHaveBeenCalled()
  })
})

describe("sentry-probe token compare", () => {
  const OLD = process.env.SENTRY_PROBE_TOKEN
  afterEach(() => {
    if (OLD === undefined) delete process.env.SENTRY_PROBE_TOKEN
    else process.env.SENTRY_PROBE_TOKEN = OLD
  })
  const call = (token: string) =>
    probe(new NextRequest("http://localhost/api/health/sentry-probe", { headers: { "x-probe-token": token } }))

  it("answers 404, not 500, to a non-ASCII header of the same string length", async () => {
    process.env.SENTRY_PROBE_TOKEN = "abcd"
    const res = await call("é".repeat(4))
    expect(res.status).toBe(404)
  })
})
