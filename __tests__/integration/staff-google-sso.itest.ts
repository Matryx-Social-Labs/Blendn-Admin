/**
 * The Google door, end to end through NextAuth's own core (SCRUM-1241, launch gate 10), against Postgres.
 *
 * Only Google is stubbed: the token exchange (`next-auth/core/lib/oauth/callback`) hands back the claims a crafted
 * profile carries, as openid-client would after verifying the id token. Everything after it is the real thing: the
 * adapter's lookup, our `signIn` callback, NextAuth's `callbackHandler` with the real PrismaAdapter, the jwt callback
 * and `events.signIn`. After every refusal the tables are read back: no "User", no "Account", no "Session" for anybody
 * the case touched.
 *
 * The session cookie's codec is the one thing swapped for a plain one: `jose` is stubbed in this runner
 * (jose-stub.ts), and what is under test is who gets in, not how the cookie is sealed.
 */
let mockClaims: Record<string, unknown> = {}
// By path: next-auth's exports map does not expose its core.
jest.mock("../../node_modules/next-auth/core/lib/oauth/callback", () => ({
  __esModule: true,
  default: async () => {
    const claims = mockClaims
    return {
      profile: { id: claims.sub, name: claims.name, email: claims.email, image: null },
      account: {
        provider: "google",
        type: "oauth",
        providerAccountId: claims.sub,
        access_token: "ya29.not-stored",
        id_token: "eyJ.not-stored",
        token_type: "Bearer",
        scope: "openid email profile",
        expires_at: 9999999999,
      },
      OAuthProfile: claims,
      cookies: [],
    }
  },
}))
jest.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-real-ip": "198.51.100.44" }),
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
}))

import { createHash, randomUUID } from "node:crypto"
import type { NextAuthOptions } from "next-auth"
import { AuthHandler } from "../../node_modules/next-auth/core"

import { closeDb, db } from "./helpers"

const DOMAIN = "matrixsociallabs.com"
const run = randomUUID().slice(0, 8)
const emails: string[] = []
const subs: string[] = []
const ids: string[] = []
let options: NextAuthOptions

beforeAll(async () => {
  process.env.DASHBOARD_GOOGLE_CLIENT_ID = "dash-web.apps.googleusercontent.com"
  process.env.DASHBOARD_GOOGLE_CLIENT_SECRET = "dash-secret"
  const { authOptions } = await import("@/lib/auth")
  options = {
    ...authOptions,
    secret: process.env.NEXTAUTH_SECRET ?? "itest-nextauth-secret-at-least-32-characters",
    jwt: { encode: async ({ token }) => JSON.stringify(token), decode: async ({ token }) => (token ? JSON.parse(token) : null) },
  }
})

afterAll(async () => {
  await db.account.deleteMany({ where: { provider: "google", providerAccountId: { in: subs } } })
  await db.audit_logs.deleteMany({ where: { user_id: { in: ids } } })
  await db.user.deleteMany({ where: { email: { in: emails } } })
  await closeDb()
})

/** A person with a row. Defaults: a live, unsuspended admin on the staff domain. */
async function person(label: string, data: Record<string, unknown> = {}) {
  const email = `itest-sso-${label}-${run}@${DOMAIN}`
  emails.push(email)
  const row = await db.user.create({ data: { email, name: label, role: "app_admin", emailVerified: new Date(), ...data } })
  ids.push(row.id)
  return { id: row.id, email: row.email }
}

/** Google's claims for an address, verified and on the Workspace unless a case says otherwise. */
function claims(email: string, extra: Record<string, unknown> = {}) {
  const sub = `1${run.replace(/\D/g, "")}${subs.length}${Date.now() % 100000}`
  subs.push(sub)
  emails.push(email)
  return { sub, email, email_verified: true, hd: DOMAIN, name: "Staff", iss: "https://accounts.google.com", ...extra }
}

/** GET /api/auth/callback/google as Google redirects there, optionally with somebody's session already in the browser. */
async function callback(profile: Record<string, unknown>, sessionOf?: string) {
  mockClaims = profile
  const headers: Record<string, string> = { host: "localhost:3104", "x-real-ip": "198.51.100.44" }
  if (sessionOf) headers.cookie = `next-auth.session-token=${encodeURIComponent(JSON.stringify({ sub: sessionOf }))}`
  const res = await AuthHandler({ req: new Request("http://localhost:3104/api/auth/callback/google?code=c&state=s", { headers }), options })
  const cookie = (res.cookies ?? []).find((c) => c.name.includes("session-token") && c.value)
  const session = cookie ? (JSON.parse(cookie.value) as { sub?: string; role?: string }) : null
  return { redirect: String(res.redirect ?? ""), sessionSet: Boolean(cookie), session }
}

/** Everything a sign-in could have written for these addresses and this Google subject. */
async function written(sub: string, addresses: string[]) {
  const [users, links, sessions, signins] = await Promise.all([
    db.user.findMany({ where: { email: { in: addresses } }, select: { id: true } }),
    db.account.findMany({ where: { provider: "google", providerAccountId: sub } }),
    // JWT sessions write no row; counted so a switch to database sessions cannot slip a refused one in.
    db.session.count({ where: { user: { email: { in: addresses } } } }),
    db.audit_logs.count({ where: { action: "auth.dashboard_signin", user_id: { in: ids } } }),
  ])
  return { users: users.length, links, sessions, signins }
}

const settled = () => new Promise((r) => setTimeout(r, 100))

describe("the right person: a live admin on the staff domain, verified, on the Workspace", () => {
  it("signs in, is linked to their own row with no Google token kept, and leaves the sign-in row with provider google", async () => {
    const admin = await person("ok")
    const google = claims(admin.email)

    const first = await callback(google)
    expect(first.redirect).not.toContain("error=")
    expect(first.session).toMatchObject({ sub: admin.id, role: "app_admin" })

    const links = await db.account.findMany({ where: { provider: "google", providerAccountId: google.sub } })
    expect(links).toEqual([
      expect.objectContaining({ userId: admin.id, type: "oauth", access_token: null, id_token: null, refresh_token: null }),
    ])

    await settled()
    const rows = await db.audit_logs.findMany({ where: { user_id: admin.id, action: "auth.dashboard_signin" } })
    expect(rows).toEqual([expect.objectContaining({ resource: "user", resource_id: admin.id, details: { provider: "google" }, ip_address: "198.51.100.44" })])

    // The next sign-in finds the link and adds nothing.
    const again = await callback(google)
    expect(again.redirect).not.toContain("error=")
    expect(await db.account.count({ where: { userId: admin.id } })).toBe(1)
  })
})

describe("the address is compared lowercased", () => {
  it("lets an admin in whose Google address arrives in capitals", async () => {
    const admin = await person("caps")
    const google = claims(admin.email.toUpperCase())
    const res = await callback(google)
    expect(res.session).toMatchObject({ sub: admin.id })
    expect(await db.account.findMany({ where: { provider: "google", providerAccountId: google.sub } })).toEqual([expect.objectContaining({ userId: admin.id })])
  })
})

describe("a password sign-in through the same handler", () => {
  it("still leaves exactly one sign-in row, marked credentials: the Google event records Google alone", async () => {
    const { hash } = await import("bcryptjs")
    const admin = await person("password", { password: await hash("Juniper-Harbour-Lantern-58", 4) })
    const csrf = randomUUID().replace(/-/g, "")
    const csrfHash = createHash("sha256").update(`${csrf}${options.secret}`).digest("hex")
    const res = await AuthHandler({
      req: new Request("http://localhost:3104/api/auth/callback/credentials", {
        method: "POST",
        headers: { host: "localhost:3104", "content-type": "application/json", "x-real-ip": "198.51.100.45", cookie: `next-auth.csrf-token=${csrf}%7C${csrfHash}` },
        body: JSON.stringify({ csrfToken: csrf, email: admin.email, password: "Juniper-Harbour-Lantern-58", json: "true" }),
      }),
      options,
    })
    expect(String(res.redirect)).not.toContain("error=")
    await settled()
    const rows = await db.audit_logs.findMany({ where: { user_id: admin.id, action: "auth.dashboard_signin" } })
    expect(rows).toEqual([expect.objectContaining({ details: { provider: "credentials" } })])
  })
})

describe("every refusal answers AccessDenied and writes nothing", () => {
  const refused = async (profile: Record<string, unknown>, addresses: string[]) => {
    const before = (await written(String(profile.sub), addresses)).signins
    const res = await callback(profile)
    expect(res.redirect).toMatch(/\/api\/auth\/error\?error=AccessDenied$/)
    expect(res.sessionSet).toBe(false)
    await settled()
    const { signins, ...rest } = await written(String(profile.sub), addresses)
    expect(signins).toBe(before)
    return rest
  }

  it("a personal Gmail account: no hd, and no row is created for it", async () => {
    const gmail = `itest-sso-gmail-${run}@gmail.com`
    expect(await refused(claims(gmail, { hd: undefined }), [gmail])).toEqual({ users: 0, links: [], sessions: 0 })
  })

  it("another Workspace's account (hd is theirs)", async () => {
    const other = `itest-sso-other-${run}@example.org`
    expect(await refused(claims(other, { hd: "example.org" }), [other])).toEqual({ users: 0, links: [], sessions: 0 })
  })

  it("a live admin whose address is off the staff domain, though their Workspace is ours (a secondary domain)", async () => {
    // hd is the Workspace's primary domain, so a user on a domain it also holds carries ours. The address decides.
    const email = `itest-sso-secondary-${run}@blendn.app`
    emails.push(email)
    const row = await db.user.create({ data: { email, name: "secondary", role: "app_admin", emailVerified: new Date() } })
    ids.push(row.id)
    expect(await refused(claims(email), [email])).toMatchObject({ users: 1, links: [], sessions: 0 })
  })

  it("an admin's own address with the hd claim missing", async () => {
    const admin = await person("nohd")
    expect(await refused(claims(admin.email, { hd: undefined }), [admin.email])).toMatchObject({ users: 1, links: [], sessions: 0 })
  })

  it("an admin's own address from another Workspace (hd is not ours)", async () => {
    const admin = await person("otherhd")
    expect(await refused(claims(admin.email, { hd: "example.org" }), [admin.email])).toMatchObject({ users: 1, links: [], sessions: 0 })
  })

  it("an admin's own address with no email_verified claim at all", async () => {
    const admin = await person("noverified")
    expect(await refused(claims(admin.email, { email_verified: undefined }), [admin.email])).toMatchObject({ users: 1, links: [], sessions: 0 })
  })

  it("an admin's own address Google has not verified", async () => {
    const admin = await person("unverified")
    expect(await refused(claims(admin.email, { email_verified: false }), [admin.email])).toMatchObject({ users: 1, links: [], sessions: 0 })
  })

  it("a staff address with no row: nobody is created", async () => {
    const nobody = `itest-sso-nobody-${run}@${DOMAIN}`
    expect(await refused(claims(nobody), [nobody])).toEqual({ users: 0, links: [], sessions: 0 })
  })

  it("a staff address whose row is not an admin", async () => {
    const organizer = await person("organizer", { role: "organizer" })
    expect(await refused(claims(organizer.email), [organizer.email])).toMatchObject({ users: 1, links: [], sessions: 0 })
  })

  it("a suspended admin", async () => {
    const admin = await person("suspended", { suspended_at: new Date() })
    expect(await refused(claims(admin.email), [admin.email])).toMatchObject({ users: 1, links: [], sessions: 0 })
  })

  it("a deleted admin", async () => {
    const admin = await person("deleted", { deletedAt: new Date() })
    expect(await refused(claims(admin.email), [admin.email])).toMatchObject({ users: 1, links: [], sessions: 0 })
  })

  it("a Google account already linked to somebody else's row", async () => {
    const owner = await person("link-owner")
    const admin = await person("link-taker")
    const google = claims(admin.email)
    await db.account.create({ data: { userId: owner.id, type: "oauth", provider: "google", providerAccountId: google.sub } })
    const after = await refused(google, [admin.email])
    expect(after.links).toEqual([expect.objectContaining({ userId: owner.id })])
  })

  it("a reissued Workspace address: the row is already linked to a different Google account", async () => {
    const admin = await person("reissued")
    const old = claims(admin.email)
    await db.account.create({ data: { userId: admin.id, type: "oauth", provider: "google", providerAccountId: old.sub } })
    const newcomer = claims(admin.email)
    expect(await refused(newcomer, [admin.email])).toMatchObject({ links: [], sessions: 0 })
    expect(await db.account.count({ where: { userId: admin.id } })).toBe(1)
  })
})

describe("where a refusal lands", () => {
  const hop = async (code: string) =>
    String((await AuthHandler({ req: new Request(`http://localhost:3104/api/auth/error?error=${code}`, { headers: { host: "localhost:3104" } }), options })).redirect)

  it("AccessDenied goes to /login, where the page says it in its own words", async () => {
    expect(await hop("AccessDenied")).toBe("/login?error=AccessDenied")
  })

  it("the others go through the sign-in page to /login too", async () => {
    expect(await hop("OAuthAccountNotLinked")).toBe("http://localhost:3104/api/auth/signin?error=OAuthAccountNotLinked")
  })
})

describe("somebody else's session already in the browser", () => {
  it("links the Google account to the admin's own row, never to the session's, and signs nobody in", async () => {
    const organizer = await person("bystander", { role: "organizer" })
    const admin = await person("behind")
    const google = claims(admin.email)

    const res = await callback(google, organizer.id)
    expect(res.redirect).toContain("error=OAuthAccountNotLinked")
    expect(res.sessionSet).toBe(false)
    expect(await db.account.findMany({ where: { provider: "google", providerAccountId: google.sub } })).toEqual([
      expect.objectContaining({ userId: admin.id }),
    ])
    expect(await db.account.count({ where: { userId: organizer.id } })).toBe(0)
  })
})
