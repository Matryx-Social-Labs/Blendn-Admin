/*
 * Platform staff sign in with the company Google account (SCRUM-1241, launch gate 10).
 *
 * The provider exists only when BOTH `DASHBOARD_GOOGLE_*` are set, and that is no environment today, so with them
 * unset sign-in is exactly what it was. `ADMIN_SSO_REQUIRED=true` refuses an admin's password the way a wrong password
 * is refused (no oracle: the mobile door still honours that password), and boot refuses the flag without the client
 * it sends admins to. What the Google callback accepts and writes is pinned against Postgres in
 * `integration/staff-google-sso.itest.ts`.
 */
import type { NextAuthOptions } from "next-auth"

const mockFindUnique = jest.fn()
const mockAuditCreate = jest.fn()
jest.mock("@/lib/db", () => ({
  db: {
    $queryRaw: () => mockSessionRows(mockFindUnique()),
    user: { findUnique: (...a: unknown[]) => mockFindUnique(...a) },
    organisation_invites: { findFirst: async () => null },
    audit_logs: { create: (...a: unknown[]) => mockAuditCreate(...a) },
    account: { findMany: (...a: unknown[]) => mockAccountFindMany(...a) },
  },
}))
const mockAccountFindMany = jest.fn()
// Stubs that would succeed: the adapter lib/auth hands NextAuth must refuse both writes all the same.
jest.mock("@auth/prisma-adapter", () => ({ PrismaAdapter: () => ({ createUser: async () => ({ id: "made" }), linkAccount: async () => undefined }) }))
const mockCompare = jest.fn(async (given: string, stored: string) => given === stored)
jest.mock("bcryptjs", () => ({ compare: (given: string, stored: string) => mockCompare(given, stored) }))

import { adminSsoRequired, dashboardGoogleClient, validateEnv } from "@/lib/env"
import { logger } from "@/lib/logger"
import { mockSessionRows } from "./support/session-account"

const BASE = {
  DATABASE_URL: "postgresql://x",
  NEXTAUTH_URL: "http://localhost:3000",
  NEXTAUTH_SECRET: "x".repeat(32),
  MOBILE_JWT_SECRET: "y".repeat(32),
}
const CLIENT = { DASHBOARD_GOOGLE_CLIENT_ID: "dash-web.apps.googleusercontent.com", DASHBOARD_GOOGLE_CLIENT_SECRET: "dash-secret" }
const UNSET = { DASHBOARD_GOOGLE_CLIENT_ID: undefined, DASHBOARD_GOOGLE_CLIENT_SECRET: undefined, ADMIN_SSO_REQUIRED: undefined }

const saved = { ...process.env }
afterEach(() => {
  process.env = { ...saved }
})
function withEnv(extra: Record<string, string | undefined>) {
  process.env = { ...saved, ...BASE, ...UNSET, ...extra } as NodeJS.ProcessEnv
}

/** `authOptions` is built when lib/auth loads, so each environment gets its own copy of the module. */
function loadAuth(): NextAuthOptions {
  let options: NextAuthOptions | undefined
  jest.isolateModules(() => {
    options = jest.requireActual<typeof import("@/lib/auth")>("@/lib/auth").authOptions
  })
  return options!
}

type Provider = { id: string; options?: Record<string, unknown> & { authorize?: Authorize }; allowDangerousEmailAccountLinking?: boolean; authorization?: unknown }
type Authorize = (c: Record<string, string>, req?: { headers: Record<string, string> }) => Promise<unknown>
const providersOf = (o: NextAuthOptions) => o.providers as unknown as Provider[]

describe("the dashboard Google client: both variables or none", () => {
  it("is off with neither set, and with only one of the two", () => {
    withEnv({})
    expect(dashboardGoogleClient()).toBeNull()
    withEnv({ DASHBOARD_GOOGLE_CLIENT_ID: CLIENT.DASHBOARD_GOOGLE_CLIENT_ID })
    expect(dashboardGoogleClient()).toBeNull()
    withEnv({ DASHBOARD_GOOGLE_CLIENT_SECRET: CLIENT.DASHBOARD_GOOGLE_CLIENT_SECRET })
    expect(dashboardGoogleClient()).toBeNull()
    withEnv({ DASHBOARD_GOOGLE_CLIENT_ID: "  ", DASHBOARD_GOOGLE_CLIENT_SECRET: "  " })
    expect(dashboardGoogleClient()).toBeNull()
  })

  it("is on with both", () => {
    withEnv(CLIENT)
    expect(dashboardGoogleClient()).toEqual({ clientId: CLIENT.DASHBOARD_GOOGLE_CLIENT_ID, clientSecret: CLIENT.DASHBOARD_GOOGLE_CLIENT_SECRET })
  })

  it("is not the mobile app's client: GOOGLE_WEB_CLIENT_ID is another audience and turns nothing on here", () => {
    withEnv({ GOOGLE_WEB_CLIENT_ID: "mobile-web.apps.googleusercontent.com" })
    expect(dashboardGoogleClient()).toBeNull()
    expect(providersOf(loadAuth()).map((p) => p.id)).toEqual(["credentials"])
  })
})

describe("ADMIN_SSO_REQUIRED", () => {
  it("is on for exactly `true`", () => {
    withEnv({ ADMIN_SSO_REQUIRED: "true" })
    expect(adminSsoRequired()).toBe(true)
    for (const v of [undefined, "false", ""]) {
      withEnv({ ADMIN_SSO_REQUIRED: v })
      expect(adminSsoRequired()).toBe(false)
    }
  })
})

describe("validateEnv: boot refuses a configuration that would lock every admin out", () => {
  it("boots with none of the three (every environment today), with the client alone, and with the client and the flag", () => {
    for (const extra of [{}, CLIENT, { ...CLIENT, ADMIN_SSO_REQUIRED: "true" }, { ...CLIENT, ADMIN_SSO_REQUIRED: "false" }]) {
      withEnv(extra)
      expect(() => validateEnv()).not.toThrow()
    }
  })

  it.each([
    ["the flag with no Google client: admins refused a password and offered no button", { ADMIN_SSO_REQUIRED: "true" }, "ADMIN_SSO_REQUIRED"],
    ["the flag with half a client", { ADMIN_SSO_REQUIRED: "true", DASHBOARD_GOOGLE_CLIENT_ID: CLIENT.DASHBOARD_GOOGLE_CLIENT_ID }, "ADMIN_SSO_REQUIRED"],
    ["the flag with a client of blanks", { ADMIN_SSO_REQUIRED: "true", DASHBOARD_GOOGLE_CLIENT_ID: " ", DASHBOARD_GOOGLE_CLIENT_SECRET: " " }, "ADMIN_SSO_REQUIRED"],
    ["an id without its secret", { DASHBOARD_GOOGLE_CLIENT_ID: CLIENT.DASHBOARD_GOOGLE_CLIENT_ID }, "DASHBOARD_GOOGLE_CLIENT_SECRET"],
    ["a secret without its id", { DASHBOARD_GOOGLE_CLIENT_SECRET: CLIENT.DASHBOARD_GOOGLE_CLIENT_SECRET }, "DASHBOARD_GOOGLE_CLIENT_SECRET"],
    ["a flag spelled TRUE, which would otherwise read as off", { ...CLIENT, ADMIN_SSO_REQUIRED: "TRUE" }, "ADMIN_SSO_REQUIRED"],
    ["a flag spelled 1", { ...CLIENT, ADMIN_SSO_REQUIRED: "1" }, "ADMIN_SSO_REQUIRED"],
  ])("refuses %s, naming the variable", (_label, extra, variable) => {
    withEnv(extra)
    const logged = jest.spyOn(logger, "error").mockImplementation(() => undefined)
    try {
      expect(() => validateEnv()).toThrow("Invalid environment variables")
      const { fieldErrors } = logged.mock.calls[0][1] as { fieldErrors: Record<string, string[]> }
      expect(Object.keys(fieldErrors)).toContain(variable)
    } finally {
      logged.mockRestore()
    }
  })
})

describe("the providers lib/auth registers", () => {
  it("is Credentials alone with the variables unset: sign-in is what it was", () => {
    withEnv({})
    expect(providersOf(loadAuth()).map((p) => p.id)).toEqual(["credentials"])
  })

  it("adds Google with both set: the dashboard's own client, the staff domain as a hint, no e-mail linking", () => {
    withEnv(CLIENT)
    const google = providersOf(loadAuth()).find((p) => p.id === "google")!
    expect(google.options).toMatchObject({
      clientId: CLIENT.DASHBOARD_GOOGLE_CLIENT_ID,
      clientSecret: CLIENT.DASHBOARD_GOOGLE_CLIENT_SECRET,
      authorization: { params: { hd: "matrixsociallabs.com", prompt: "select_account" } },
    })
    expect(google.options?.allowDangerousEmailAccountLinking).toBeFalsy()
  })

  it("sends a refused Google sign-in back to /login, not to NextAuth's own page", () => {
    withEnv(CLIENT)
    expect(loadAuth().pages).toMatchObject({ signIn: "/login", error: "/login" })
  })

  it("never creates a user or links an account through the adapter: the callback links the checked row itself", async () => {
    withEnv(CLIENT)
    const adapter = loadAuth().adapter!
    await expect(Promise.resolve().then(() => adapter.createUser!({ email: "x@matrixsociallabs.com", emailVerified: null } as never))).rejects.toThrow()
    await expect(
      Promise.resolve().then(() => adapter.linkAccount!({ userId: "u", type: "oauth", provider: "google", providerAccountId: "1" } as never))
    ).rejects.toThrow()
  })

  it("refuses, and does not throw, when the database fails mid-check: a thrown message would land in the redirect URL", async () => {
    withEnv(CLIENT)
    const signIn = loadAuth().callbacks!.signIn!
    mockFindUnique.mockResolvedValue({ id: "u-a", email: "priya@matrixsociallabs.com", role: "app_admin", deletedAt: null, suspended_at: null })
    mockAccountFindMany.mockRejectedValue(new Error('Invalid `prisma.account.findMany()` invocation: relation "Account" ...'))
    const profile = { email: "priya@matrixsociallabs.com", email_verified: true, hd: "matrixsociallabs.com" }
    await expect(signIn({ user: { id: "1" }, account: { provider: "google", type: "oauth", providerAccountId: "1" }, profile } as never)).resolves.toBe(false)
  })

  it("lets Credentials through the signIn callback as before, and no provider it does not know", async () => {
    withEnv(CLIENT)
    const signIn = loadAuth().callbacks!.signIn!
    const user = { id: "u", email: "o@x.test" }
    await expect(signIn({ user, account: { provider: "credentials", type: "credentials", providerAccountId: "u" } } as never)).resolves.toBe(true)
    await expect(signIn({ user, account: { provider: "github", type: "oauth", providerAccountId: "1" }, profile: {} } as never)).resolves.toBe(false)
  })
})

describe("authorize under ADMIN_SSO_REQUIRED", () => {
  const PASSWORD = "the-right-one"
  let hop = 0
  const account = (role: string) => ({ id: `u-${role}`, email: `${role}@x.test`, name: role, role, password: PASSWORD, deletedAt: null, suspended_at: null })
  const signInAs = (auth: NextAuthOptions, role: string, password = PASSWORD) => {
    const authorize = providersOf(auth)[0].options!.authorize!
    return authorize({ email: `${role}@x.test`, password }, { headers: { "x-real-ip": `203.0.113.${++hop}` } })
  }
  const settled = () => new Promise((resolve) => setImmediate(resolve))
  const signinRows = () => mockAuditCreate.mock.calls.map(([arg]) => arg.data).filter((row) => row.action === "auth.dashboard_signin")

  beforeEach(() => {
    mockFindUnique.mockReset()
    mockAuditCreate.mockReset().mockResolvedValue({})
  })

  it("refuses it after the password is compared, and leaves the limiter and the known-device cookie as a wrong one does", async () => {
    withEnv({ ...CLIENT, ADMIN_SSO_REQUIRED: "true" })
    let auth: NextAuthOptions | undefined
    let settle: jest.SpyInstance | undefined
    let deviceCookie: jest.SpyInstance | undefined
    jest.isolateModules(() => {
      settle = jest.spyOn(jest.requireActual<typeof import("@/lib/dashboard-signin-limits")>("@/lib/dashboard-signin-limits"), "settleSigninSuccess")
      deviceCookie = jest.spyOn(jest.requireActual<typeof import("@/lib/known-device")>("@/lib/known-device"), "knownDeviceCookie")
      auth = jest.requireActual<typeof import("@/lib/auth")>("@/lib/auth").authOptions
    })
    mockFindUnique.mockResolvedValue(account("app_admin"))
    mockCompare.mockClear()
    await expect(signInAs(auth!, "app_admin")).resolves.toBeNull()
    expect(mockCompare).toHaveBeenCalledTimes(1)
    expect(settle).not.toHaveBeenCalled()
    expect(deviceCookie).not.toHaveBeenCalled()
  })

  it("refuses an admin's right password exactly as a wrong one: null, no row, no error to tell them apart", async () => {
    withEnv({ ...CLIENT, ADMIN_SSO_REQUIRED: "true" })
    const auth = loadAuth()
    mockFindUnique.mockResolvedValue(account("app_admin"))
    await expect(signInAs(auth, "app_admin")).resolves.toBeNull()
    await expect(signInAs(auth, "app_admin", "wrong")).resolves.toBeNull()
    await settled()
    expect(signinRows()).toEqual([])
  })

  it("still lets an organizer in with a password", async () => {
    withEnv({ ...CLIENT, ADMIN_SSO_REQUIRED: "true" })
    const auth = loadAuth()
    mockFindUnique.mockResolvedValue(account("organizer"))
    await expect(signInAs(auth, "organizer")).resolves.toMatchObject({ id: "u-organizer" })
  })

  it("lets an admin in with a password while the flag is unset (every environment today)", async () => {
    withEnv(CLIENT)
    const auth = loadAuth()
    mockFindUnique.mockResolvedValue(account("app_admin"))
    await expect(signInAs(auth, "app_admin")).resolves.toMatchObject({ id: "u-app_admin" })
  })
})
