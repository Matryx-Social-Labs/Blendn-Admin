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
  },
}))
// Stubs that would succeed: the adapter lib/auth hands NextAuth must refuse both writes all the same.
jest.mock("@auth/prisma-adapter", () => ({ PrismaAdapter: () => ({ createUser: async () => ({ id: "made" }), linkAccount: async () => undefined }) }))
jest.mock("bcryptjs", () => ({ compare: async (given: string, stored: string) => given === stored }))

import { adminSsoRequired, dashboardGoogleClient, validateEnv } from "@/lib/env"
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
    ["the flag with no Google client: admins refused a password and offered no button", { ADMIN_SSO_REQUIRED: "true" }],
    ["the flag with half a client", { ADMIN_SSO_REQUIRED: "true", DASHBOARD_GOOGLE_CLIENT_ID: CLIENT.DASHBOARD_GOOGLE_CLIENT_ID }],
    ["an id without its secret", { DASHBOARD_GOOGLE_CLIENT_ID: CLIENT.DASHBOARD_GOOGLE_CLIENT_ID }],
    ["a secret without its id", { DASHBOARD_GOOGLE_CLIENT_SECRET: CLIENT.DASHBOARD_GOOGLE_CLIENT_SECRET }],
    ["a flag spelled TRUE, which would otherwise read as off", { ...CLIENT, ADMIN_SSO_REQUIRED: "TRUE" }],
    ["a flag spelled 1", { ...CLIENT, ADMIN_SSO_REQUIRED: "1" }],
  ])("refuses %s", (_label, extra) => {
    withEnv(extra)
    expect(() => validateEnv()).toThrow("Invalid environment variables")
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
