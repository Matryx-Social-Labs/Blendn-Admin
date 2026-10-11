/**
 * A dashboard session ends when the database says it has (step 18 security
 * review, M6 and the two scans after it).
 *
 * The reset link revoked the account's phones and left its dashboard sessions
 * alone: they are JWTs with no row to delete, so whoever held a stolen session
 * kept it after the owner reset the password to lock them out. The first fix
 * demoted such a session to `attendee` and was itself open three ways: a
 * database that could not answer left the old role in place; a session from
 * before `signedInAt` existed was judged by `iat`, which every refresh
 * re-stamps, so one refresh after the demotion revived it; and the middleware
 * bounced the refused session from /login straight back to /dashboard.
 *
 * Now one rule, `isRevoked` (lib/session-revocation.ts), is read by the jwt
 * callback, by `currentUser` and by the socket handshake; the jwt callback
 * throws on it, and NextAuth turns a throwing callback into no session at all.
 *
 * Driven here through NextAuth itself: a cookie minted the way sign-in mints
 * it, then read by `getServerSession`, the route handler, a server action, an
 * API route, the dashboard layout, the socket handshake and the middleware.
 */
const mockJar = new Map<string, string>()
jest.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({
    getAll: () => [...mockJar].map(([name, value]) => ({ name, value })),
    get: (name: string) => (mockJar.has(name) ? { name, value: mockJar.get(name) } : undefined),
  }),
}))
// A session handed to `currentUser` from anywhere: undefined means the real one.
let mockSession: unknown = undefined
jest.mock("@/lib/auth", () => {
  const actual = jest.requireActual("@/lib/auth")
  return { ...actual, getAuth: () => (mockSession === undefined ? actual.getAuth() : Promise.resolve(mockSession)) }
})
// The adapter is ESM-only and the jwt strategy never touches it.
jest.mock("@auth/prisma-adapter", () => ({ PrismaAdapter: () => ({}) }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
jest.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error(`redirect ${to}`), { to })
  },
}))

import bcrypt from "bcryptjs"
import { NextRequest } from "next/server"
import { encode, type JWT } from "next-auth/jwt"

import { GET as nextAuthRoute } from "@/app/api/auth/[...nextauth]/route"
import { POST as resetPassword } from "@/app/api/auth/reset-password/route"
import { GET as search } from "@/app/api/search/route"
import DashboardLayout from "@/app/dashboard/layout"
import { changePassword, endDashboardSessions, revokeMobileSessions, updateProfile } from "@/lib/account-actions"
import { authOptions, getAuth } from "@/lib/auth"
import { currentUser } from "@/lib/current-user"
import { db as appDb } from "@/lib/db"
import { signRefreshToken, storeRefreshToken } from "@/lib/mobile-auth"
import { issuePasswordResetLink } from "@/lib/password-reset"
import { resetMemoryStore } from "@/lib/rate-limit-store"
import { authenticateDashboardSocket } from "@/lib/socket-ops-auth"
import { middleware } from "@/middleware"

import { closeDb, db, makeUser } from "./helpers"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const refreshRoute = require("@/app/api/mobile/auth/refresh/route") as typeof import("@/app/api/mobile/auth/refresh/route")

const SECRET = process.env.NEXTAUTH_SECRET!
const COOKIE = (process.env.NEXTAUTH_URL ?? "").startsWith("https://")
  ? "__Secure-next-auth.session-token"
  : "next-auth.session-token"
const OLD = "Old-password-for-m6-2026!"
const users: string[] = []

type JwtCallback = (a: { token: JWT; user?: unknown; account?: unknown; trigger?: string; session?: unknown }) => Promise<JWT>
const jwt = authOptions.callbacks!.jwt! as unknown as JwtCallback

afterAll(async () => {
  await db.push_tokens.deleteMany({ where: { user_id: { in: users } } })
  await db.mobile_refresh_tokens.deleteMany({ where: { user_id: { in: users } } })
  await db.password_reset_tokens.deleteMany({ where: { user_id: { in: users } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

beforeEach(() => {
  resetMemoryStore()
  mockJar.clear()
  mockSession = undefined
})

async function host() {
  const id = await makeUser("m6_host", "organizer")
  users.push(id)
  await db.user.update({ where: { id }, data: { password: await bcrypt.hash(OLD, 4) } })
  return id
}

/** Sign in the way NextAuth does: the jwt callback with the user, then the token. */
function signInToken(id: string, provider = "credentials") {
  return jwt({
    token: { sub: id } as JWT,
    user: { id, role: "organizer" },
    account: { provider, type: provider === "credentials" ? "credentials" : "oauth" },
    trigger: "signIn",
  })
}

async function signedInCookie(id: string, provider = "credentials") {
  return encode({ token: await signInToken(id, provider), secret: SECRET })
}

function holding(cookie: string) {
  mockJar.clear()
  mockJar.set(COOKIE, cookie)
}

async function resetPasswordOf(id: string) {
  const link = await issuePasswordResetLink(id, 3_600_000)
  const token = new URL(link).searchParams.get("token")!
  const res = await resetPassword(
    new NextRequest("http://localhost:3000/api/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "203.0.113.66" },
      body: JSON.stringify({ token, password: "Copper-Meadow-Lighthouse-47" }),
    })
  )
  expect(res.status).toBe(200)
}

const sessionRoute = () =>
  nextAuthRoute(new NextRequest("http://localhost:3000/api/auth/session"), {
    params: Promise.resolve({ nextauth: ["session"] }),
  })

describe("a reset ends the sessions signed in before it", () => {
  it.each(["credentials", "google"])(
    "a %s session: no session, no user, refused by an action, an API route and the dashboard, and its cookie cleared",
    async (provider) => {
      const id = await host()
      const cookie = await signedInCookie(id, provider)

      holding(cookie)
      expect((await getAuth())?.user.id).toBe(id)
      expect(await currentUser()).toEqual({ id, role: "organizer" })

      await resetPasswordOf(id)

      holding(cookie)
      expect(await getAuth()).toBeNull()
      expect(await currentUser()).toBeNull()
      await expect(updateProfile("Somebody else entirely")).rejects.toThrow("Unauthorized")
      expect((await search(new NextRequest("http://localhost:3000/api/search?q=ab"))).status).toBe(401)
      await expect(DashboardLayout({ children: null })).rejects.toMatchObject({ to: "/login" })
      expect(await authenticateDashboardSocket(`${COOKIE}=${cookie}`)).toBeNull()

      // The client's own refresh: an empty session, and the cookie cleared.
      const res = await sessionRoute()
      expect(await res.json()).toEqual({})
      expect(res.headers.get("set-cookie")).toMatch(new RegExp(`${COOKIE.replace(/\./g, "\\.")}=;`))
    }
  )

  it("a session that signs in after the reset is a session", async () => {
    const id = await host()
    await resetPasswordOf(id)
    holding(await signedInCookie(id))
    expect(await currentUser()).toEqual({ id, role: "organizer" })
  })

  it("changing the password in Settings does the same", async () => {
    const id = await host()
    const cookie = await signedInCookie(id)
    holding(cookie)
    await new Promise((r) => setTimeout(r, 5))
    expect(await changePassword(OLD, "Turquoise-Lantern-Harbour-91")).toMatchObject({ ok: true })
    holding(cookie)
    expect(await getAuth()).toBeNull()
  })
})

describe("Settings → Sessions ends what it says (SCRUM-603)", () => {
  it("Dashboard: ending from one browser ends every browser, this one included, wherever a cookie is read", async () => {
    const id = await host()
    const here = await signedInCookie(id)
    const elsewhere = await signedInCookie(id)
    holding(here)
    expect(await currentUser()).toEqual({ id, role: "organizer" })

    await endDashboardSessions()

    // Read back: the stamp the rule judges by.
    const { sessions_revoked_at } = await db.user.findUniqueOrThrow({ where: { id }, select: { sessions_revoked_at: true } })
    expect(sessions_revoked_at).toBeInstanceOf(Date)
    for (const cookie of [here, elsewhere]) {
      holding(cookie)
      expect(await getAuth()).toBeNull()
      expect(await currentUser()).toBeNull()
      expect(await authenticateDashboardSocket(`${COOKIE}=${cookie}`)).toBeNull()
      const res = await sessionRoute()
      expect(await res.json()).toEqual({})
      expect(res.headers.get("set-cookie")).toMatch(new RegExp(`${COOKIE.replace(/\./g, "\\.")}=;`))
    }

    // Signing in again is a session; the password did not change.
    holding(await signedInCookie(id))
    expect(await currentUser()).toEqual({ id, role: "organizer" })
  })

  it("Mobile app: every phone's refresh is refused and its push token is gone; nobody else's", async () => {
    const id = await makeUser("m6_phone")
    const other = await makeUser("m6_other")
    users.push(id, other)
    const { email } = await db.user.findUniqueOrThrow({ where: { id }, select: { email: true } })
    const phone = signRefreshToken(id, email)
    await storeRefreshToken(id, phone)
    await db.push_tokens.createMany({
      data: [
        { user_id: id, token: `ExponentPushToken[m6-${id}]`, platform: "ios" },
        { user_id: other, token: `ExponentPushToken[m6-${other}]`, platform: "ios" },
      ],
    })
    mockSession = { user: { id, role: "attendee", signedInAt: Date.now() } }

    expect(await revokeMobileSessions()).toBe(1)

    const res = await refreshRoute.POST(
      new NextRequest("http://localhost/api/mobile/auth/refresh", {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": "203.0.113.67" },
        body: JSON.stringify({ refreshToken: phone }),
      })
    )
    expect(res.status).toBe(401)
    expect(await db.push_tokens.count({ where: { user_id: id } })).toBe(0)
    expect(await db.push_tokens.count({ where: { user_id: other } })).toBe(1)
  })
})

describe("nothing revives an ended session", () => {
  it("an update() after the reset, whatever it carries", async () => {
    const id = await host()
    const token = await signInToken(id)
    await new Promise((r) => setTimeout(r, 5))
    await resetPasswordOf(id)
    const later = Math.floor(Date.now() / 1000) + 5
    await expect(
      jwt({ token: { ...token, iat: later }, trigger: "update", session: { signedInAt: Date.now() + 10_000, role: "app_admin" } })
    ).rejects.toThrow()
  })

  it("a refresh: the session is judged by when it signed in, not by its last re-encode", async () => {
    const id = await host()
    const token = await signInToken(id)
    await new Promise((r) => setTimeout(r, 5))
    await resetPasswordOf(id)
    await expect(jwt({ token: { ...token, iat: Math.floor(Date.now() / 1000) + 5 } })).rejects.toThrow()
  })

  it("a session from before signedInAt existed keeps its first iat through a refresh", async () => {
    const id = await host()
    const iat = Math.floor(Date.now() / 1000) - 60
    const legacy = { sub: id, role: "organizer", iat } as JWT
    const refreshed = await jwt({ token: legacy })
    expect(refreshed.signedInAt).toBe(iat * 1000)

    await resetPasswordOf(id)
    // Re-encoded after the reset with a fresh iat: still the session from before it.
    await expect(jwt({ token: { ...refreshed, iat: Math.floor(Date.now() / 1000) + 5 } })).rejects.toThrow()
    await expect(jwt({ token: { ...legacy } })).rejects.toThrow()
  })

  it("a token that cannot say when it signed in is ended, password changed or not", async () => {
    const id = await host()
    await expect(jwt({ token: { sub: id, role: "organizer" } as JWT })).rejects.toThrow()
  })

  it("a token with no user is ended", async () => {
    await expect(jwt({ token: { role: "app_admin", signedInAt: Date.now() } as JWT })).rejects.toThrow()
  })

  it("an iat in the same second as the change is from before it; the next second is after", async () => {
    const id = await host()
    const second = Math.floor(Date.now() / 1000) - 30
    await db.user.update({ where: { id }, data: { password_changed_at: new Date(second * 1000 + 500) } })
    await expect(jwt({ token: { sub: id, role: "organizer", iat: second } as JWT })).rejects.toThrow()
    await expect(jwt({ token: { sub: id, role: "organizer", iat: second + 1 } as JWT })).resolves.toMatchObject({ role: "organizer" })
  })

  it("suspension and deletion end it the same way", async () => {
    const id = await host()
    const cookie = await signedInCookie(id)
    await db.user.update({ where: { id }, data: { suspended_at: new Date() } })
    holding(cookie)
    expect(await getAuth()).toBeNull()
    await db.user.update({ where: { id }, data: { suspended_at: null, deletedAt: new Date() } })
    expect(await getAuth()).toBeNull()
    expect(await authenticateDashboardSocket(`${COOKIE}=${cookie}`)).toBeNull()
  })
})

describe("a database that cannot answer grants nothing", () => {
  it("the jwt callback, getAuth and currentUser", async () => {
    const id = await host()
    const token = await signInToken(id)
    holding(await encode({ token, secret: SECRET }))
    const read = jest.spyOn(appDb.user, "findUnique").mockRejectedValue(new Error("Connection terminated unexpectedly"))
    try {
      await expect(jwt({ token })).rejects.toThrow()
      expect(await getAuth()).toBeNull()
      expect(await currentUser()).toBeNull()
      expect(read).toHaveBeenCalled()
    } finally {
      read.mockRestore()
    }
  })

  it("currentUser's own read failing is an error, never a user built from the session", async () => {
    const id = await host()
    mockSession = { user: { id, role: "app_admin", signedInAt: Date.now() } }
    const read = jest.spyOn(appDb.user, "findUnique").mockRejectedValue(new Error("Connection terminated unexpectedly"))
    try {
      await expect(currentUser()).rejects.toThrow()
    } finally {
      read.mockRestore()
    }
  })
})

describe("currentUser applies the rule to whatever session it is handed", () => {
  it("refuses one from before the reset, and one that cannot say when it signed in", async () => {
    const id = await host()
    const before = Date.now() - 60_000
    await resetPasswordOf(id)
    mockSession = { user: { id, role: "organizer", signedInAt: before } }
    expect(await currentUser()).toBeNull()
    mockSession = { user: { id, role: "organizer" } }
    expect(await currentUser()).toBeNull()
  })

  it("takes the role from the database, not the session", async () => {
    const id = await host()
    await db.user.update({ where: { id }, data: { role: "venue_owner" } })
    mockSession = { user: { id, role: "app_admin", signedInAt: Date.now() } }
    expect(await currentUser()).toEqual({ id, role: "venue_owner" })
  })
})

describe("the middleware", () => {
  it("does not send a cookie it cannot vouch for from /login back to the dashboard", async () => {
    // Edge middleware reads the cookie's claims and cannot ask the database.
    // The pages can: they refuse the session and send it to /login, and
    // bouncing it straight back was a redirect loop for every ended session.
    const id = await host()
    const cookie = await signedInCookie(id)
    await resetPasswordOf(id)
    const res = await middleware(new NextRequest("http://localhost:3000/login", { headers: { cookie: `${COOKIE}=${cookie}` } }))
    expect(res.headers.get("location")).toBeNull()
  })

  it("treats the cleared cookie as signed out", async () => {
    const res = await middleware(new NextRequest("http://localhost:3000/dashboard/events"))
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login")
  })
})
