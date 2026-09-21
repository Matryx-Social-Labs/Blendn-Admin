import { NextRequest } from "next/server"
import bcrypt from "bcryptjs"

/*
 * The client app is for attendees (SCRUM-198).
 *
 * Driven on staging: an organiser signed in to the app on two phones through
 * the ordinary email screen and reached the Pulse. Organisers, venue owners,
 * sponsors and admins have the dashboard; until the operator app exists the
 * attendee app must refuse them — at sign-in, and at refresh so a session
 * that already exists ends within one access-token lifetime.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
import { signRefreshToken, storeRefreshToken, STAFF_MESSAGE } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeUser } from "./helpers"
// eslint-disable-next-line @typescript-eslint/no-require-imports
const signinRoute = require("@/app/api/mobile/auth/signin/route") as typeof import("@/app/api/mobile/auth/signin/route")
// eslint-disable-next-line @typescript-eslint/no-require-imports
const refreshRoute = require("@/app/api/mobile/auth/refresh/route") as typeof import("@/app/api/mobile/auth/refresh/route")

const PASSWORD = "orchard-lantern-quiet-42"
const users: string[] = []
afterAll(async () => {
  await cleanup(users, [])
  await closeDb()
})

const post = (path: string, body: unknown, ip: string) =>
  new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": ip },
    body: JSON.stringify(body),
  })

async function withPassword(label: string, role: "attendee" | "organizer" | "venue_owner" | "sponsor" | "app_admin") {
  const id = await makeUser(label, role as never)
  users.push(id)
  const { email } = await db.user.update({
    where: { id },
    data: { password: await bcrypt.hash(PASSWORD, 4), role },
    select: { email: true },
  })
  return { id, email }
}

describe("sign-in", () => {
  it("refuses every staff role with the right password, and says where to go", async () => {
    let n = 0
    for (const role of ["organizer", "venue_owner", "sponsor", "app_admin"] as const) {
      const { email } = await withPassword(`aoa-${role}`, role)
      // A fresh address per call keeps the per-network limiter out of the way.
      const res = await signinRoute.POST(post("/api/mobile/auth/signin", { email, password: PASSWORD }, `10.9.0.${++n}`))
      expect(res.status).toBe(403)
      expect((await res.json()).error).toBe(STAFF_MESSAGE)
    }
  })

  it("still signs in an attendee", async () => {
    const { email } = await withPassword("aoa-attendee", "attendee")
    const res = await signinRoute.POST(post("/api/mobile/auth/signin", { email, password: PASSWORD }, "10.9.0.20"))
    expect(res.status).toBe(200)
  })
})

describe("refresh", () => {
  it("ends a staff session that already existed, and keeps an attendee's", async () => {
    const staff = await withPassword("aoa-refresh-staff", "organizer")
    const attendee = await withPassword("aoa-refresh-att", "attendee")
    const staffToken = signRefreshToken(staff.id, staff.email)
    const attendeeToken = signRefreshToken(attendee.id, attendee.email)
    await storeRefreshToken(staff.id, staffToken)
    await storeRefreshToken(attendee.id, attendeeToken)

    const refused = await refreshRoute.POST(post("/api/mobile/auth/refresh", { refreshToken: staffToken }, "10.9.0.30"))
    expect(refused.status).toBe(403)
    expect((await refused.json()).error).toBe(STAFF_MESSAGE)

    const ok = await refreshRoute.POST(post("/api/mobile/auth/refresh", { refreshToken: attendeeToken }, "10.9.0.31"))
    expect(ok.status).toBe(200)
  })
})
