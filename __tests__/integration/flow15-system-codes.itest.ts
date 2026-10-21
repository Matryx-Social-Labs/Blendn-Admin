/*
 * Flow 15: the server says exactly why (account codes, session-end reasons,
 * signInMethod, socket handshake codes), asserted on the real route handlers
 * against real rows.
 *
 * Two promises are held at once. The new `errorCode` is on every refusal a
 * client has to tell apart — and the sentence beside it is the one installed
 * builds already match on, word for word, because those builds never read the
 * code. So every case here checks both.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
// Only the two identity-provider checks are replaced; everything after them is real.
jest.mock("@/lib/mobile-auth", () => ({
  ...jest.requireActual("@/lib/mobile-auth"),
  verifyGoogleIdToken: jest.fn(),
  verifyAppleIdToken: jest.fn(),
}))

import bcrypt from "bcryptjs"
import { createServer } from "http"
import type { AddressInfo } from "net"
import { NextRequest } from "next/server"
import { io as connect } from "socket.io-client"

import { POST as resetPassword } from "@/app/api/auth/reset-password/route"
import {
  signAccessToken,
  signRefreshToken,
  storeRefreshToken,
  STAFF_MESSAGE,
  SUSPENDED_MESSAGE,
  verifyAppleIdToken,
  verifyGoogleIdToken,
} from "@/lib/mobile-auth"
import { issuePasswordResetLink } from "@/lib/password-reset"
import { resetMemoryStore } from "@/lib/rate-limit-store"
import { initSocketServer } from "@/lib/socket-server"
import { stopSponsoredScheduler } from "@/lib/sponsored-scheduler"

import { closeDb, db, makeUser, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const signinRoute = require("@/app/api/mobile/auth/signin/route") as typeof import("@/app/api/mobile/auth/signin/route")
const googleRoute = require("@/app/api/mobile/auth/google/route") as typeof import("@/app/api/mobile/auth/google/route")
const appleRoute = require("@/app/api/mobile/auth/apple/route") as typeof import("@/app/api/mobile/auth/apple/route")
const refreshRoute = require("@/app/api/mobile/auth/refresh/route") as typeof import("@/app/api/mobile/auth/refresh/route")
const sessionRoute = require("@/app/api/mobile/auth/session/route") as typeof import("@/app/api/mobile/auth/session/route")
const signoutRoute = require("@/app/api/mobile/auth/signout/route") as typeof import("@/app/api/mobile/auth/signout/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const PASSWORD = "orchard-lantern-quiet-42"
const DELETED_SENTENCE = "Account not found"
const users: string[] = []

const httpServer = createServer()
const io = initSocketServer(httpServer)
const sockets: ReturnType<typeof connect>[] = []

beforeAll(async () => {
  await new Promise<void>((resolve) => httpServer.listen(0, resolve))
})

afterAll(async () => {
  for (const socket of sockets) socket.close()
  stopSponsoredScheduler()
  globalThis.__blendnSocketIo = null
  await new Promise<void>((resolve) => io.close(() => resolve()))
  await db.user_oauth_accounts.deleteMany({ where: { user_id: { in: users } } })
  await db.password_reset_tokens.deleteMany({ where: { user_id: { in: users } } })
  await db.mobile_refresh_tokens.deleteMany({ where: { user_id: { in: users } } })
  await db.push_tokens.deleteMany({ where: { user_id: { in: users } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

let ipCounter = 0
beforeEach(() => resetMemoryStore())
const nextIp = () => `10.15.${Math.floor(++ipCounter / 250)}.${(ipCounter % 250) + 1}`

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": nextIp(), ...headers },
    body: JSON.stringify(body),
  })
const get = (path: string, accessToken: string) =>
  new NextRequest(`http://localhost${path}`, { headers: { authorization: `Bearer ${accessToken}` } })

type AccountState = "suspended" | "staff" | "deleted"

/** An account in the given state, with a password, and an OAuth link for each provider. */
async function account(label: string, state: AccountState | "ok" = "ok") {
  const id = await makeUser(testId(label))
  users.push(id)
  const googleId = testId("g")
  const appleId = testId("a")
  const user = await db.user.update({
    where: { id },
    data: {
      password: await bcrypt.hash(PASSWORD, 4),
      role: state === "staff" ? "organizer" : "attendee",
      suspended_at: state === "suspended" ? new Date() : null,
      deletedAt: state === "deleted" ? new Date() : null,
      oauth_accounts: {
        create: [
          { provider: "google", provider_id: googleId },
          { provider: "apple", provider_id: appleId },
        ],
      },
    },
    select: { email: true },
  })
  return { id, email: user.email, googleId, appleId }
}

/**
 * `getAuthenticatedUser` turns away an account deleted or suspended in the last
 * twenty minutes at once, with a bare 401 (lib/account-blocklist.ts), from a set
 * it re-reads every 30 s. Which of these tests meets a re-read is a matter of
 * timing, and the 403 under test is what a session gets once that window has
 * passed — so the set is marked as just read, and the account's own row speaks.
 */
function blocklistJustRead() {
  const shared = globalThis as typeof globalThis & { __blendnBlocklist?: { fetchedAt: number } }
  if (shared.__blendnBlocklist) shared.__blendnBlocklist.fetchedAt = Date.now()
}

const THE_REFUSALS = [
  ["suspended", 403, "ACCOUNT_SUSPENDED", SUSPENDED_MESSAGE],
  ["staff", 403, "ACCOUNT_STAFF", STAFF_MESSAGE],
] as const

describe("account codes: the sentence stays, the code is added", () => {
  describe.each(THE_REFUSALS)("%s", (state, status, code, sentence) => {
    it("sign-in", async () => {
      const a = await account(`sg-${state}`, state)
      const res = await signinRoute.POST(post("/api/mobile/auth/signin", { email: a.email, password: PASSWORD }))
      expect(res.status).toBe(status)
      expect(await res.json()).toEqual({ success: false, error: sentence, errorCode: code })
    })

    it("Google", async () => {
      const a = await account(`go-${state}`, state)
      jest.mocked(verifyGoogleIdToken).mockResolvedValue({ sub: a.googleId, email: a.email } as never)
      const res = await googleRoute.POST(post("/api/mobile/auth/google", { idToken: "t" }))
      expect(res.status).toBe(status)
      expect(await res.json()).toEqual({ success: false, error: sentence, errorCode: code })
    })

    it("Apple", async () => {
      const a = await account(`ap-${state}`, state)
      jest.mocked(verifyAppleIdToken).mockResolvedValue({ sub: a.appleId, email: a.email } as never)
      const res = await appleRoute.POST(post("/api/mobile/auth/apple", { identityToken: "t" }))
      expect(res.status).toBe(status)
      expect(await res.json()).toEqual({ success: false, error: sentence, errorCode: code })
    })

    it("refresh, for a token that is still live", async () => {
      const a = await account(`rf-${state}`, state)
      const token = signRefreshToken(a.id, a.email)
      await storeRefreshToken(a.id, token)
      const res = await refreshRoute.POST(post("/api/mobile/auth/refresh", { refreshToken: token }))
      expect(res.status).toBe(status)
      expect(await res.json()).toEqual({ success: false, error: sentence, errorCode: code })
    })

    it("session", async () => {
      const a = await account(`se-${state}`, state)
      blocklistJustRead()
      const res = await sessionRoute.GET(get("/api/mobile/auth/session", signAccessToken(a.id, a.email)))
      expect(res.status).toBe(status)
      expect(await res.json()).toEqual({ success: false, error: sentence, errorCode: code })
    })
  })

  it("refresh tells a session the suspension ended why, with the same sentence", async () => {
    const a = await account("rf-susp-revoked")
    const token = signRefreshToken(a.id, a.email)
    await storeRefreshToken(a.id, token)
    const at = new Date()
    await db.mobile_refresh_tokens.updateMany({ where: { user_id: a.id }, data: { revoked_at: at } })
    await db.user.update({ where: { id: a.id }, data: { suspended_at: new Date(at.getTime() - 1000) } })
    const res = await refreshRoute.POST(post("/api/mobile/auth/refresh", { refreshToken: token }))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ success: false, error: SUSPENDED_MESSAGE, errorCode: "ACCOUNT_SUSPENDED" })
  })

  describe("deleted", () => {
    it("Google: 401 ACCOUNT_DELETED, 'Account not found'", async () => {
      const a = await account("go-deleted", "deleted")
      jest.mocked(verifyGoogleIdToken).mockResolvedValue({ sub: a.googleId, email: a.email } as never)
      const res = await googleRoute.POST(post("/api/mobile/auth/google", { idToken: "t" }))
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ success: false, error: DELETED_SENTENCE, errorCode: "ACCOUNT_DELETED" })
    })

    it("Apple: 401 ACCOUNT_DELETED, 'Account not found'", async () => {
      const a = await account("ap-deleted", "deleted")
      jest.mocked(verifyAppleIdToken).mockResolvedValue({ sub: a.appleId, email: a.email } as never)
      const res = await appleRoute.POST(post("/api/mobile/auth/apple", { identityToken: "t" }))
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ success: false, error: DELETED_SENTENCE, errorCode: "ACCOUNT_DELETED" })
    })

    it("refresh: a signed token of a deleted account is ACCOUNT_DELETED, with the generic sentence", async () => {
      // Erasure hard-deletes the refresh-token rows, so the token has no row left to find.
      const a = await account("rf-deleted", "deleted")
      const res = await refreshRoute.POST(
        post("/api/mobile/auth/refresh", { refreshToken: signRefreshToken(a.id, a.email) })
      )
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({
        success: false,
        error: "Invalid or expired refresh token",
        errorCode: "ACCOUNT_DELETED",
      })
    })

    it("refresh: a forged token learns nothing", async () => {
      const a = await account("rf-forged", "deleted")
      const forged = `${signRefreshToken(a.id, a.email)}x`
      const res = await refreshRoute.POST(post("/api/mobile/auth/refresh", { refreshToken: forged }))
      expect(res.status).toBe(401)
      expect((await res.json()).errorCode).toBe("UNAUTHORIZED")
    })

    it("session: ACCOUNT_DELETED on the 404, with its sentence", async () => {
      const a = await account("se-deleted", "deleted")
      blocklistJustRead()
      const res = await sessionRoute.GET(get("/api/mobile/auth/session", signAccessToken(a.id, a.email)))
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ success: false, error: "User not found", errorCode: "ACCOUNT_DELETED" })
    })

    it("sign-in with a password still never confirms the account existed", async () => {
      const a = await account("sg-deleted", "deleted")
      const res = await signinRoute.POST(post("/api/mobile/auth/signin", { email: a.email, password: PASSWORD }))
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ success: false, error: "Invalid email or password", errorCode: "UNAUTHORIZED" })
    })
  })
})

describe("session-end reasons, read back from the refresh", () => {
  const refresh = (token: string) => refreshRoute.POST(post("/api/mobile/auth/refresh", { refreshToken: token }))

  async function phones(label: string, count = 2) {
    const a = await account(label)
    const tokens: string[] = []
    for (let i = 0; i < count; i++) {
      const token = signRefreshToken(a.id, a.email)
      await storeRefreshToken(a.id, token)
      tokens.push(token)
    }
    return { ...a, tokens }
  }

  it("sign-out-everywhere (the route's revoke-all branch) stores the reason and the refresh says SESSION_REVOKED_ELSEWHERE", async () => {
    const a = await phones("so-all")
    const res = await signoutRoute.POST(post("/api/mobile/auth/signout", {}, { authorization: `Bearer ${signAccessToken(a.id, a.email)}` }))
    expect(res.status).toBe(200)

    const rows = await db.mobile_refresh_tokens.findMany({ where: { user_id: a.id } })
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.revoked_at && r.revoked_reason === "signout_all")).toBe(true)
    expect((await db.user.findUniqueOrThrow({ where: { id: a.id } })).mobile_sessions_revoked_at).not.toBeNull()

    for (const token of a.tokens) {
      const refused = await refresh(token)
      expect(refused.status).toBe(401)
      expect(await refused.json()).toEqual({
        success: false,
        error: "Invalid or expired refresh token",
        errorCode: "SESSION_REVOKED_ELSEWHERE",
      })
    }
  })

  it("a password reset stores the reason and the refresh says PASSWORD_RESET", async () => {
    const a = await phones("pw-reset")
    const link = await issuePasswordResetLink(a.id, 3_600_000)
    const res = await resetPassword(
      post("/api/auth/reset-password", { token: new URL(link).searchParams.get("token"), password: "Copper-Meadow-Lighthouse-47" })
    )
    expect(res.status).toBe(200)

    const rows = await db.mobile_refresh_tokens.findMany({ where: { user_id: a.id } })
    expect(rows.every((r) => r.revoked_reason === "password_reset")).toBe(true)
    const refused = await refresh(a.tokens[0])
    expect(refused.status).toBe(401)
    expect((await refused.json()).errorCode).toBe("PASSWORD_RESET")
  })

  it("signing out one device sets no reason: its refresh is the plain 401", async () => {
    const a = await phones("so-one")
    const res = await signoutRoute.POST(
      post("/api/mobile/auth/signout", { refreshToken: a.tokens[0] }, { authorization: `Bearer ${signAccessToken(a.id, a.email)}` })
    )
    expect(res.status).toBe(200)
    const row = await db.mobile_refresh_tokens.findFirstOrThrow({ where: { user_id: a.id, revoked_at: { not: null } } })
    expect(row.revoked_reason).toBeNull()
    const refused = await refresh(a.tokens[0])
    expect(refused.status).toBe(401)
    expect((await refused.json()).errorCode).toBe("UNAUTHORIZED")
    // And the other phone is untouched.
    expect((await refresh(a.tokens[1])).status).toBe(200)
  })

  it("a replay of a token a sign-out-everywhere ended, long after, is told why and does not end the sessions opened since", async () => {
    const a = await phones("so-replay", 1)
    await signoutRoute.POST(post("/api/mobile/auth/signout", {}, { authorization: `Bearer ${signAccessToken(a.id, a.email)}` }))
    // The person signs in again; the old phone retries its old token an hour later.
    const fresh = signRefreshToken(a.id, a.email)
    await storeRefreshToken(a.id, fresh)
    await db.mobile_refresh_tokens.updateMany({
      where: { user_id: a.id, revoked_at: { not: null } },
      data: { revoked_at: new Date(Date.now() - 60 * 60 * 1000) },
    })

    const refused = await refresh(a.tokens[0])
    expect((await refused.json()).errorCode).toBe("SESSION_REVOKED_ELSEWHERE")
    // Read as theft, as it used to be, this would have revoked `fresh`.
    expect((await refresh(fresh)).status).toBe(200)
  })

  it("a token that was never ours learns no reason", async () => {
    const a = await phones("so-forged", 1)
    await signoutRoute.POST(post("/api/mobile/auth/signout", {}, { authorization: `Bearer ${signAccessToken(a.id, a.email)}` }))
    const res = await refresh(`${a.tokens[0]}x`)
    expect(res.status).toBe(401)
    expect((await res.json()).errorCode).toBe("UNAUTHORIZED")
  })
})

describe("signInMethod on /auth/session", () => {
  const method = async (a: { id: string; email: string }) => {
    const res = await sessionRoute.GET(get("/api/mobile/auth/session", signAccessToken(a.id, a.email)))
    expect(res.status).toBe(200)
    return (await res.json()).data.signInMethod
  }

  async function bare(label: string, providers: string[], password: boolean) {
    const id = await makeUser(testId(label))
    users.push(id)
    const user = await db.user.update({
      where: { id },
      data: { password: password ? await bcrypt.hash(PASSWORD, 4) : null },
      select: { email: true },
    })
    // Oldest first, so the last one listed is the most recently linked.
    for (const provider of providers) {
      await db.user_oauth_accounts.create({ data: { user_id: id, provider, provider_id: testId(provider), created_at: new Date(Date.now() + providers.indexOf(provider) * 1000) } })
    }
    return { id, email: user.email }
  }

  it("is 'password' for an account with a password", async () => {
    expect(await method(await bare("sm-pw", [], true))).toBe("password")
  })
  it("is 'google' for a Google-only account", async () => {
    expect(await method(await bare("sm-g", ["google"], false))).toBe("google")
  })
  it("is 'apple' for an Apple-only account", async () => {
    expect(await method(await bare("sm-a", ["apple"], false))).toBe("apple")
  })
  it("is the most recently linked provider when there are two and no password", async () => {
    expect(await method(await bare("sm-ga", ["google", "apple"], false))).toBe("apple")
  })
  it("is 'password' when an account has a password and a provider (it is the one with a password to change)", async () => {
    expect(await method(await bare("sm-both", ["google"], true))).toBe("password")
  })
})

describe("socket handshake codes", () => {
  async function handshake(userId: string, email: string) {
    const { port } = httpServer.address() as AddressInfo
    const socket = connect(`http://localhost:${port}`, {
      auth: { token: signAccessToken(userId, email) },
      transports: ["websocket"],
      reconnection: false,
    })
    sockets.push(socket)
    return new Promise<{ connected: true } | { message: string; data?: { code?: string } }>((resolve) => {
      socket.on("connect", () => resolve({ connected: true }))
      socket.on("connect_error", (error) => resolve({ message: error.message, data: (error as Error & { data?: { code?: string } }).data }))
    })
  }

  it.each([
    ["suspended", "ACCOUNT_SUSPENDED"],
    ["staff", "ACCOUNT_STAFF"],
    ["deleted", "ACCOUNT_DELETED"],
  ] as const)("a %s account is refused with data.code %s and the message it always had", async (state, code) => {
    const a = await account(`sk-${state}`, state)
    expect(await handshake(a.id, a.email)).toEqual({ message: "Authentication required", data: { code } })
  })

  it("a live account connects", async () => {
    const a = await account("sk-ok")
    expect(await handshake(a.id, a.email)).toEqual({ connected: true })
  })

  it("a phone signed out everywhere is refused, with no account code (it is the session's to name, not the socket's)", async () => {
    const a = await account("sk-signedout")
    const token = signAccessToken(a.id, a.email)
    await db.user.update({ where: { id: a.id }, data: { mobile_sessions_revoked_at: new Date(Date.now() + 1000) } })
    const { port } = httpServer.address() as AddressInfo
    const socket = connect(`http://localhost:${port}`, { auth: { token }, transports: ["websocket"], reconnection: false })
    sockets.push(socket)
    const error = await new Promise<Error & { data?: unknown }>((resolve) => socket.on("connect_error", resolve))
    expect(error.message).toBe("Authentication required")
    expect(error.data).toBeUndefined()
  })
})
