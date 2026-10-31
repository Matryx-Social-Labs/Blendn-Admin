import { NextRequest } from "next/server"
import bcrypt from "bcryptjs"

/*
 * Account deletion asks who is deleting (SCRUM-944 (3), owner ruling A-18, 2026-11-01): a password account sends its
 * password, an SSO account a Google or Apple identity token issued in the last 15 minutes and linked to it. A bearer
 * token alone no longer deletes, once MOBILE_MIN_APP_VERSION passes the build that sends the proof; until then a
 * request with no proof is today's (older builds must still be able to delete: App Review 5.1.1(v)).
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/tigris", () => ({ deletePrefix: jest.fn().mockResolvedValue(0), withdrawFromPublic: jest.fn() }))
jest.mock("next/server", () => ({ ...jest.requireActual("next/server"), after: jest.fn() }))

import { jwtVerify } from "jose"
import { signAccessToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeUser, onboard, testId } from "./helpers"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const accountRoute = require("@/app/api/mobile/account/route") as typeof import("@/app/api/mobile/account/route")

const PASSWORD = "orchard-lantern-quiet-42"
const users: string[] = []
const saved = { ...process.env }
afterEach(() => {
  process.env = { ...saved }
  jest.clearAllMocks()
})
afterAll(async () => {
  await db.audit_logs.deleteMany({ where: { resource_id: { in: users } } })
  await cleanup(users, [])
  await closeDb()
})

async function person(opts: { password?: boolean; appleSub?: string } = {}) {
  const id = await makeUser("del-reauth")
  users.push(id)
  await onboard(id)
  if (opts.password !== false) await db.user.update({ where: { id }, data: { password: await bcrypt.hash(PASSWORD, 4) } })
  if (opts.appleSub) await db.user_oauth_accounts.create({ data: { user_id: id, provider: "apple", provider_id: opts.appleSub } })
  return id
}

async function del(userId: string, body?: unknown) {
  const { email } = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } })
  return accountRoute.DELETE(
    new NextRequest("http://localhost/api/mobile/account", {
      method: "DELETE",
      headers: { authorization: `Bearer ${signAccessToken(userId, email)}`, "content-type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
  )
}
const gone = async (id: string) => (await db.user.findUniqueOrThrow({ where: { id }, select: { deletedAt: true } })).deletedAt !== null
const codeOf = async (res: Response) => ((await res.json()) as { errorCode?: string }).errorCode
const apple = (sub: string, issuedSecondsAgo: number) =>
  (jwtVerify as jest.Mock).mockResolvedValue({ payload: { sub, iat: Math.floor(Date.now() / 1000) - issuedSecondsAgo, exp: Math.floor(Date.now() / 1000) + 600 } })

describe("deleting an account asks who is deleting", () => {
  it("deletes a password account with its password", async () => {
    const id = await person()
    expect((await del(id, { password: PASSWORD })).status).toBe(200)
    expect(await gone(id)).toBe(true)
  })

  it("refuses a wrong password, PASSWORD_INCORRECT, and deletes nothing", async () => {
    const id = await person()
    const res = await del(id, { password: "not-it-at-all" })
    expect(res.status).toBe(403)
    expect(await codeOf(res)).toBe("PASSWORD_INCORRECT")
    expect(await gone(id)).toBe(false)
  })

  // Security review: a stolen bearer token must not make this route a password oracle (the user limit allows 10 a
  // minute). Wrong passwords here get sign-in's numbers: 5 in 15 minutes, then 429 even for the right one.
  it("stops guessing after 5 wrong passwords in 15 minutes", async () => {
    const id = await person()
    for (let i = 0; i < 5; i++) expect(await codeOf(await del(id, { password: `guess-${i}-xxxxxx` }))).toBe("PASSWORD_INCORRECT")
    const res = await del(id, { password: PASSWORD })
    expect(res.status).toBe(429)
    expect(await gone(id)).toBe(false)
  })

  it("deletes an Apple account with a fresh identity token linked to it", async () => {
    const sub = testId("asub")
    const id = await person({ password: false, appleSub: sub })
    apple(sub, 60)
    expect((await del(id, { appleIdentityToken: "id-token" })).status).toBe(200)
    expect(await gone(id)).toBe(true)
  })

  it("refuses a token older than 15 minutes, or linked to someone else, REAUTH_REQUIRED", async () => {
    const sub = testId("asub")
    const id = await person({ password: false, appleSub: sub })
    apple(sub, 16 * 60)
    const stale = await del(id, { appleIdentityToken: "id-token" })
    expect(stale.status).toBe(403)
    expect(await codeOf(stale)).toBe("REAUTH_REQUIRED")
    apple(testId("other"), 30)
    expect(await codeOf(await del(id, { appleIdentityToken: "id-token" }))).toBe("REAUTH_REQUIRED")
    expect(await gone(id)).toBe(false)
  })

  it("keeps today's answer for a request with no proof while older builds are still supported", async () => {
    delete process.env.MOBILE_MIN_APP_VERSION
    const id = await person()
    expect((await del(id)).status).toBe(200)
  })

  it("refuses a request with no proof once the minimum version carries the proof, REAUTH_REQUIRED", async () => {
    process.env.MOBILE_MIN_APP_VERSION = "1.0.1"
    const id = await person()
    const res = await del(id)
    expect(res.status).toBe(403)
    expect(await codeOf(res)).toBe("REAUTH_REQUIRED")
    expect(await gone(id)).toBe(false)
  })
})
