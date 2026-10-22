import { NextRequest } from "next/server"

/*
 * The reset link's page needs to know whose account it is for (SV15): an
 * attendee's lives on the phone (Open Blend'n), a dashboard role's on the web
 * (/login). A dead link still answers only `valid: false`.
 */
jest.mock("@/lib/rate-limit", () => ({ rateLimit: jest.fn().mockResolvedValue(null) }))
import { randomBytes } from "crypto"
import { GET, POST } from "@/app/api/auth/reset-password/route"
import { hashInviteToken } from "@/lib/org-invites"
import { closeDb, db, makeUser, testId } from "./helpers"

const users: string[] = []
afterAll(async () => {
  await db.audit_logs.deleteMany({ where: { resource_id: { in: users } } })
  await db.password_reset_tokens.deleteMany({ where: { user_id: { in: users } } })
  await db.mobile_refresh_tokens.deleteMany({ where: { user_id: { in: users } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

async function linkFor(role: "attendee" | "organizer" | "app_admin") {
  const id = await makeUser(testId(`rpa-${role}`), role)
  users.push(id)
  const token = randomBytes(24).toString("hex")
  await db.password_reset_tokens.create({
    data: { user_id: id, token_hash: hashInviteToken(token), expires_at: new Date(Date.now() + 3600_000) },
  })
  return token
}

const check = (token: string) => GET(new NextRequest(`http://localhost/api/auth/reset-password?token=${token}`))
const reset = (token: string) =>
  POST(
    new NextRequest("http://localhost/api/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, password: "a long enough passphrase 123" }),
    })
  )

it("an attendee's live link says attendee, and finishing it returns the app to open", async () => {
  const token = await linkFor("attendee")
  expect(await (await check(token)).json()).toEqual({ valid: true, audience: "attendee" })
  const res = await reset(token)
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({
    ok: true,
    audience: "attendee",
    app: { deepLink: "blendn://", appStoreUrl: null, playStoreUrl: null },
  })
})

it.each(["organizer", "app_admin"] as const)("a %s link says dashboard, and returns no app", async (role) => {
  const token = await linkFor(role)
  expect(await (await check(token)).json()).toEqual({ valid: true, audience: "dashboard" })
  expect(await (await reset(token)).json()).toEqual({ ok: true, audience: "dashboard", app: null })
})

it("a dead link says nothing about whose it was", async () => {
  const token = await linkFor("attendee")
  await reset(token)
  expect(await (await check(token)).json()).toEqual({ valid: false })
  expect(await (await check("not-a-token")).json()).toEqual({ valid: false })
})
