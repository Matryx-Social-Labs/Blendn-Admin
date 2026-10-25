import { NextRequest } from "next/server"

/*
 * Deleting an Apple-linked account revokes its Sign in with Apple grant
 * (App Store 5.1.1(v)), and never at the cost of the deletion: Apple down, no
 * key, or no code from the app, the account is still erased, and what happened
 * to the grant is a warning and an audit row. The route is the real one, on
 * real rows; only Apple (fetch) and storage are stood in for.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/tigris", () => ({ deletePrefix: jest.fn().mockResolvedValue(0), withdrawFromPublic: jest.fn() }))
import { generateKeyPairSync } from "crypto"
import jwt from "jsonwebtoken"
import { logger } from "@/lib/logger"
import { signAccessToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeUser, onboard, testId } from "./helpers"
// eslint-disable-next-line @typescript-eslint/no-require-imports
const accountRoute = require("@/app/api/mobile/account/route") as typeof import("@/app/api/mobile/account/route")

const users: string[] = []
const saved = { ...process.env }
const PEM = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString()
const CODE = "c0de-from-the-app"

const answer = (status: number, body: unknown) =>
  ({ ok: status < 400, status, text: async () => JSON.stringify(body) }) as unknown as Response

beforeEach(() => {
  process.env.APPLE_TEAM_ID = "TEAM123456"
  process.env.APPLE_KEY_ID = "KEY1234567"
  process.env.APPLE_PRIVATE_KEY = PEM
})

afterEach(() => {
  process.env = { ...saved }
  jest.restoreAllMocks()
})

afterAll(async () => {
  await db.audit_logs.deleteMany({ where: { resource_id: { in: users } } })
  await cleanup(users, [])
  await closeDb()
})

/** The linked Apple user id of each fixture, which the exchange's id_token must carry. */
const subOf = new Map<string, string>()
const idToken = (sub: string) => jwt.sign({ sub }, "not-checked")

async function appleUser(linked = true) {
  const id = await makeUser("apple-del")
  users.push(id)
  await onboard(id)
  if (linked) {
    const sub = testId("sub")
    subOf.set(id, sub)
    await db.user_oauth_accounts.create({ data: { user_id: id, provider: "apple", provider_id: sub } })
  }
  return id
}

async function deleteAccount(userId: string, body?: unknown) {
  const { email } = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } })
  return accountRoute.DELETE(
    new NextRequest("http://localhost/api/mobile/account", {
      method: "DELETE",
      headers: { "content-type": "application/json", authorization: `Bearer ${signAccessToken(userId, email)}` },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
  )
}

/** `auditLog` is fire-and-forget: wait for its row. */
async function revokeAudit(userId: string) {
  for (let i = 0; i < 50; i++) {
    const row = await db.audit_logs.findFirst({ where: { resource_id: userId, action: "account.apple_revoke" } })
    if (row) return row
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error("no account.apple_revoke audit row")
}

async function expectErased(userId: string) {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { deletedAt: true, email: true } })
  expect(user.deletedAt).not.toBeNull()
  expect(user.email).toBe(`deleted-${userId}@deleted.blendn.invalid`)
  expect(await db.user_oauth_accounts.count({ where: { user_id: userId } })).toBe(0)
}

it("exchanges the code, revokes the grant, erases the account and audits it", async () => {
  const id = await appleUser()
  const fetchSpy = jest
    .spyOn(global, "fetch")
    .mockResolvedValueOnce(answer(200, { access_token: "at", refresh_token: "rt", id_token: idToken(subOf.get(id)!) }))
    .mockResolvedValueOnce(answer(200, {}))

  const res = await deleteAccount(id, { appleAuthorizationCode: CODE })

  expect(res.status).toBe(200)
  await expectErased(id)
  expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
    "https://appleid.apple.com/auth/token",
    "https://appleid.apple.com/auth/revoke",
  ])
  const row = await revokeAudit(id)
  expect(row.details).toEqual({ outcome: "revoked" })
})

it("revokes nothing when the code is for a different Apple ID, still erases, and audits it without either id", async () => {
  const id = await appleUser()
  const other = "000999.someone-else.0001"
  const fetchSpy = jest
    .spyOn(global, "fetch")
    .mockResolvedValueOnce(answer(200, { access_token: "at", refresh_token: "rt", id_token: idToken(other) }))
  const warn = jest.spyOn(logger, "warn")

  const res = await deleteAccount(id, { appleAuthorizationCode: CODE })

  expect(res.status).toBe(200)
  await expectErased(id)
  expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual(["https://appleid.apple.com/auth/token"])
  const row = await revokeAudit(id)
  expect(row.details).toEqual({ outcome: "skipped", reason: "different_apple_id" })
  const said = JSON.stringify([row.details, warn.mock.calls])
  expect(said).not.toContain(other)
  expect(said).not.toContain(subOf.get(id)!)
})

it("still erases the account when Apple is down, and audits the failure without the code", async () => {
  const id = await appleUser()
  jest.spyOn(global, "fetch").mockRejectedValue(new Error("connect ECONNREFUSED"))
  const warn = jest.spyOn(logger, "warn")

  const res = await deleteAccount(id, { appleAuthorizationCode: CODE })

  expect(res.status).toBe(200)
  await expectErased(id)
  const row = await revokeAudit(id)
  expect(row.details).toEqual({ outcome: "failed", reason: "connect ECONNREFUSED" })
  expect(JSON.stringify(row.details)).not.toContain(CODE)
  expect(JSON.stringify(warn.mock.calls)).not.toContain(CODE)
  expect(warn).toHaveBeenCalledWith("Account deletion: Sign in with Apple grant NOT revoked", expect.objectContaining({ userId: id }))
})

it("still erases the account when the app sent no code, and calls nobody", async () => {
  const id = await appleUser()
  const fetchSpy = jest.spyOn(global, "fetch")

  const res = await deleteAccount(id)

  expect(res.status).toBe(200)
  await expectErased(id)
  expect(fetchSpy).not.toHaveBeenCalled()
  expect((await revokeAudit(id)).details).toEqual({ outcome: "skipped", reason: "no_code" })
})

it("still erases the account when the key is not configured", async () => {
  const id = await appleUser()
  delete process.env.APPLE_PRIVATE_KEY
  const fetchSpy = jest.spyOn(global, "fetch")

  const res = await deleteAccount(id, { appleAuthorizationCode: CODE })

  expect(res.status).toBe(200)
  await expectErased(id)
  expect(fetchSpy).not.toHaveBeenCalled()
  expect((await revokeAudit(id)).details).toEqual({ outcome: "skipped", reason: "not_configured" })
})

it("does nothing with Apple for an account that never signed in with Apple", async () => {
  const id = await appleUser(false)
  const fetchSpy = jest.spyOn(global, "fetch")

  const res = await deleteAccount(id, { appleAuthorizationCode: CODE })

  expect(res.status).toBe(200)
  await expectErased(id)
  expect(fetchSpy).not.toHaveBeenCalled()
  await new Promise((r) => setTimeout(r, 200))
  expect(await db.audit_logs.count({ where: { resource_id: id, action: "account.apple_revoke" } })).toBe(0)
})

it("refuses a malformed body before erasing anything", async () => {
  const id = await appleUser()
  const res = await deleteAccount(id, { appleAuthorizationCode: 42 })
  expect(res.status).toBe(400)
  expect((await res.json()).errorCode).toBe("VALIDATION_FAILED")
  expect((await db.user.findUniqueOrThrow({ where: { id }, select: { deletedAt: true } })).deletedAt).toBeNull()
})
