/*
 * Signing out has to take the push token with it.
 *
 * This was the worst defect in the product and it needed three things to fail
 * at once, which is why nobody caught it:
 *
 *  1. The client cleared its access token *before* firing the authenticated
 *     DELETE for the push token, so that request always 401'd.
 *  2. The Settings sign-out never attempted the removal at all.
 *  3. This route revoked refresh tokens and never touched `push_tokens`.
 *
 * The row then co-existed with the next user's, because the unique on that
 * table is `(user_id, token)` and not `(token)`. So the next person to sign in
 * on that phone received the previous account's notifications — and DM push
 * bodies carry up to 100 characters of verbatim message text. Only uninstalling
 * the app ever cleared it.
 *
 * The server half is tested rather than the client half because the server is
 * the one that cannot be raced: whatever the client does with its own storage,
 * the row is gone by the time this handler returns.
 */

const mockDb = {
  push_tokens: { deleteMany: jest.fn() },
}

const mockAuth = jest.fn()
const mockRevokeAll = jest.fn()
const mockRevokeOne = jest.fn()

jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("@/lib/mobile-auth", () => ({
  getAuthenticatedUser: (...a: unknown[]) => mockAuth(...a),
  revokeUserRefreshTokens: (...a: unknown[]) => mockRevokeAll(...a),
  revokeRefreshToken: (...a: unknown[]) => mockRevokeOne(...a),
}))
jest.mock("@/lib/audit-log", () => ({
  auditLog: jest.fn(),
  getRequestIp: () => "127.0.0.1",
}))

import { NextRequest } from "next/server"

import { POST } from "@/app/api/mobile/auth/signout/route"

const USER = "11111111-1111-1111-1111-111111111111"
const DEVICE = "ExponentPushToken[this-phone]"

const req = (body?: Record<string, unknown>) =>
  new NextRequest("https://api.blendn.app/api/mobile/auth/signout", {
    method: "POST",
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

beforeEach(() => {
  jest.clearAllMocks()
  mockAuth.mockResolvedValue({ userId: USER })
  mockDb.push_tokens.deleteMany.mockResolvedValue({ count: 1 })
})

describe("signing out clears the push token", () => {
  it("deletes this device's token when the client names it", async () => {
    await POST(req({ refreshToken: "rt-abc", pushToken: DEVICE }))

    expect(mockDb.push_tokens.deleteMany).toHaveBeenCalledWith({
      where: { user_id: USER, token: DEVICE },
    })
  })

  it("always scopes by user_id, so a shared phone keeps the other account's token", async () => {
    await POST(req({ refreshToken: "rt-abc", pushToken: DEVICE }))

    const { where } = mockDb.push_tokens.deleteMany.mock.calls[0][0]
    expect(where.user_id).toBe(USER)
  })

  it("clears every token when signing out of all devices", async () => {
    /*
     * "Signed out from all devices" has to mean everywhere. A phone still
     * holding a token after that is the same bug with a longer name.
     */
    await POST(req({}))

    expect(mockRevokeAll).toHaveBeenCalledWith(USER)
    expect(mockDb.push_tokens.deleteMany).toHaveBeenCalledWith({
      where: { user_id: USER },
    })
  })

  it("clears every token when the client did not say which device it is", async () => {
    /*
     * An older build, or a cold start that lost the module-level ref. We cannot
     * delete the right row, and the two ways to be wrong are not symmetric:
     * clearing too much costs a re-registration, clearing too little leaves a
     * stranger reading somebody's DMs. Fail toward the annoyance.
     */
    await POST(req({ refreshToken: "rt-abc" }))

    expect(mockDb.push_tokens.deleteMany).toHaveBeenCalledWith({
      where: { user_id: USER },
    })
  })

  it("clears every token when the body is absent entirely", async () => {
    await POST(req())

    expect(mockRevokeAll).toHaveBeenCalledWith(USER)
    expect(mockDb.push_tokens.deleteMany).toHaveBeenCalledWith({
      where: { user_id: USER },
    })
  })

  it("does not touch tokens for an unauthenticated caller", async () => {
    mockAuth.mockResolvedValue(null)

    const res = await POST(req({ pushToken: DEVICE }))

    expect(res.status).toBe(401)
    expect(mockDb.push_tokens.deleteMany).not.toHaveBeenCalled()
  })
})
