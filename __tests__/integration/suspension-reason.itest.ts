/**
 * SCRUM-1174. A person suspended from a report is told the report's category and
 * where to appeal, on refresh and on sign-in, and on nothing a stranger can
 * reach: a wrong password stays the plain 401. Reinstating clears the reason.
 * Driven through the real moderation action and the real auth routes.
 */
let session: { user: { id: string; role: "app_admin" } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: async () => (session?.user ? { ...session, user: { signedInAt: Date.now(), ...session.user } } : session) }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("@/lib/socket-server", () => ({
  emitChatMessageHidden: jest.fn(),
  evictUserSockets: jest.fn(),
  closeRoomSockets: jest.fn(),
  getIO: () => null,
}))

import bcrypt from "bcryptjs"
import { NextRequest } from "next/server"
import { resolveReport } from "@/app/dashboard/moderation/reports/actions"
import { COMPANY } from "@/lib/company"
import { signRefreshToken, storeRefreshToken } from "@/lib/mobile-auth"
import { resetMemoryStore } from "@/lib/rate-limit-store"
import { cleanup, closeDb, db, makeUser, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const refreshRoute = require("@/app/api/mobile/auth/refresh/route") as typeof import("@/app/api/mobile/auth/refresh/route")
const signinRoute = require("@/app/api/mobile/auth/signin/route") as typeof import("@/app/api/mobile/auth/signin/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const PASSWORD = "ember-violet-harbour-17"
const users: string[] = []
let admin = ""
let ip = 0

beforeAll(async () => {
  admin = await makeUser("sr_admin", "app_admin")
  users.push(admin)
  session = { user: { id: admin, role: "app_admin" } }
})
beforeEach(() => resetMemoryStore())

afterAll(async () => {
  await db.audit_logs.deleteMany({ where: { user_id: admin } })
  await db.notifications.deleteMany({ where: { user_id: { in: users } } })
  await db.user_reports.deleteMany({ where: { reporter_id: { in: users } } })
  await db.mobile_refresh_tokens.deleteMany({ where: { user_id: { in: users } } })
  await cleanup(users, [])
  await closeDb()
})

const post = (path: string, body: unknown) =>
  new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": `10.74.0.${++ip}` },
    body: JSON.stringify(body),
  })

async function call(res: Promise<Response> | Response) {
  const r = await res
  return { status: r.status, body: (await r.json()) as { error?: string; errorCode?: string; reasonCode?: string } }
}

/** A signed-in attendee with a password, reported by somebody for `reason`. */
async function reportedFor(reason: string) {
  const reporter = await makeUser(testId("sr_reporter"))
  const reported = await makeUser(testId("sr_reported"))
  users.push(reporter, reported)
  const { email } = await db.user.update({
    where: { id: reported },
    data: { password: await bcrypt.hash(PASSWORD, 4) },
    select: { email: true },
  })
  const token = signRefreshToken(reported, email)
  await storeRefreshToken(reported, token)
  const report = await db.user_reports.create({ data: { reporter_id: reporter, reported_id: reported, reason, status: "pending" } })
  return { reported, email, token, report }
}

it("suspended from a harassment report: refresh and sign-in name it and the appeal address; reinstate clears it", async () => {
  const { reported, email, token, report } = await reportedFor("harassment")

  await resolveReport("user", report.id, "suspend")
  const suspended = await db.user.findUniqueOrThrow({ where: { id: reported }, select: { suspended_at: true, suspension_reason: true } })
  expect(suspended.suspended_at).not.toBeNull()
  expect(suspended.suspension_reason).toBe("harassment")

  const refresh = await call(refreshRoute.POST(post("/api/mobile/auth/refresh", { refreshToken: token })))
  expect(refresh.status).toBe(403)
  expect(refresh.body.errorCode).toBe("FORBIDDEN")
  expect(refresh.body.reasonCode).toBe("ACCOUNT_SUSPENDED")
  expect(refresh.body.error).toContain("harassment")
  expect(refresh.body.error).toContain(COMPANY.grievance.email)

  const signin = await call(signinRoute.POST(post("/api/mobile/auth/signin", { email, password: PASSWORD })))
  expect(signin.status).toBe(403)
  expect(signin.body).toEqual({ success: false, error: refresh.body.error, errorCode: "FORBIDDEN", reasonCode: "ACCOUNT_SUSPENDED" })

  // A stranger with the address and no password learns nothing.
  const wrong = await call(signinRoute.POST(post("/api/mobile/auth/signin", { email, password: "not-the-password-0" })))
  expect(wrong.status).toBe(401)
  expect(JSON.stringify(wrong.body)).not.toMatch(/suspend|harassment|grievance/i)

  await resolveReport("user", report.id, "reinstate")
  const lifted = await db.user.findUniqueOrThrow({ where: { id: reported }, select: { suspended_at: true, suspension_reason: true } })
  expect(lifted).toEqual({ suspended_at: null, suspension_reason: null })
})

it("a report in the reporter's own words suspends as community guidelines, and the words are never shown", async () => {
  const words = "he was creepy to my friend at the bar"
  const { reported, token, report } = await reportedFor(words)

  await resolveReport("user", report.id, "suspend")
  const row = await db.user.findUniqueOrThrow({ where: { id: reported }, select: { suspension_reason: true } })
  expect(row.suspension_reason).toBe("community_guidelines")

  const refresh = await call(refreshRoute.POST(post("/api/mobile/auth/refresh", { refreshToken: token })))
  expect(refresh.status).toBe(403)
  expect(refresh.body.error).toContain("community guidelines")
  expect(refresh.body.error).not.toContain(words)
})
