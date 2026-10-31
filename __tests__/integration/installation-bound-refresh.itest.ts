import { NextRequest } from "next/server"
import bcrypt from "bcryptjs"

/*
 * A refresh token replayed inside the grace window is accepted only from the installation that held it (owner ruling
 * A-18 (2), 2026-11-01). The 20-minute tolerance stays: cutting it to 60 s brought back SCRUM-138, a phone replaying 869 s
 * after a lost rotation and being signed out. But a replay from another installation is theft, and ends the family.
 * A session that records no installation (an older app) is accepted as before.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

import { closeDb, db, testId } from "./helpers"

/* eslint-disable @typescript-eslint/no-require-imports */
const signinRoute = require("@/app/api/mobile/auth/signin/route") as typeof import("@/app/api/mobile/auth/signin/route")
const refreshRoute = require("@/app/api/mobile/auth/refresh/route") as typeof import("@/app/api/mobile/auth/refresh/route")
/* eslint-enable @typescript-eslint/no-require-imports */

const PASSWORD = "orchard-lantern-quiet-42"
const PHONE = "7c2f8f0e-4c1e-4c55-9c62-0f3a8a1b2c3d"
const OTHER = "1d9e6b4a-2f7c-4e8b-a1d3-5c6e7f8a9b0c"
const users: string[] = []

afterAll(async () => {
  await db.mobile_refresh_tokens.deleteMany({ where: { user_id: { in: users } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

const net = `10.${Math.floor(Math.random() * 200) + 50}`
let n = 0
const post = (path: string, body: unknown) =>
  new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-real-ip": `${net}.9.${++n}` },
    body: JSON.stringify(body),
  })

async function signedIn(installationId?: string) {
  const id = testId("inst_bound")
  const email = `${id}@itest.invalid`
  await db.user.create({ data: { id, email, name: "Bound", role: "attendee", password: await bcrypt.hash(PASSWORD, 4) } })
  users.push(id)
  const deviceInfo = { platform: "ios", ...(installationId && { installationId }) }
  const res = await signinRoute.POST(post("/api/mobile/auth/signin", { email, password: PASSWORD, deviceInfo }))
  expect(res.status).toBe(200)
  return { id, refreshToken: ((await res.json()) as { data: { refreshToken: string } }).data.refreshToken }
}

const refresh = async (refreshToken: string, installationId?: string) =>
  refreshRoute.POST(post("/api/mobile/auth/refresh", { refreshToken, ...(installationId && { installationId }) }))
const live = (userId: string) => db.mobile_refresh_tokens.count({ where: { user_id: userId, revoked_at: null } })

describe("a refresh session bound to an installation", () => {
  it("keeps its installation across a rotation", async () => {
    const me = await signedIn(PHONE)
    expect((await refresh(me.refreshToken, PHONE)).status).toBe(200)
    const rows = await db.mobile_refresh_tokens.findMany({ where: { user_id: me.id, revoked_at: null } })
    expect(rows.map((r) => (r.device_info as { installationId?: string } | null)?.installationId)).toEqual([PHONE])
  })

  it("accepts a lost-rotation replay from the same installation", async () => {
    const me = await signedIn(PHONE)
    expect((await refresh(me.refreshToken, PHONE)).status).toBe(200)
    expect((await refresh(me.refreshToken, PHONE)).status).toBe(200)
    expect(await live(me.id)).toBe(1)
  })

  it("ends every session when another installation replays it", async () => {
    const me = await signedIn(PHONE)
    expect((await refresh(me.refreshToken, PHONE)).status).toBe(200)
    expect((await refresh(me.refreshToken, OTHER)).status).toBe(401)
    expect(await live(me.id)).toBe(0)
  })

  // Final review: a request naming no installation is most likely the owner's own app on a path that forgot it (or a
  // rolled-back build). Refuse that token, end nothing: a thief gains nothing from it, and the owner is not signed out.
  it("refuses a bound token that names no installation, without ending any session", async () => {
    const me = await signedIn(PHONE)
    expect((await refresh(me.refreshToken, PHONE)).status).toBe(200)
    expect((await refresh(me.refreshToken)).status).toBe(401)
    expect(await live(me.id)).toBe(1)
  })

  it("refuses a live bound token that names no installation, ending nothing", async () => {
    const me = await signedIn(PHONE)
    expect((await refresh(me.refreshToken)).status).toBe(401)
    expect(await live(me.id)).toBe(1)
  })

  // Review 5: a stolen, rotated-out token replayed without the field must still meet reuse detection.
  it("ends the family for a headerless replay after the successor was used", async () => {
    const me = await signedIn(PHONE)
    const r1 = (await (await refresh(me.refreshToken, PHONE)).json()) as { data: { refreshToken: string } }
    expect((await refresh(r1.data.refreshToken, PHONE)).status).toBe(200)
    expect((await refresh(me.refreshToken)).status).toBe(401)
    expect(await live(me.id)).toBe(0)
  })

  it("ends the family for a headerless replay past the grace", async () => {
    const me = await signedIn(PHONE)
    expect((await refresh(me.refreshToken, PHONE)).status).toBe(200)
    await db.mobile_refresh_tokens.updateMany({
      where: { user_id: me.id, revoked_at: { not: null } },
      data: { revoked_at: new Date(Date.now() - 30 * 60 * 1000) },
    })
    expect((await refresh(me.refreshToken)).status).toBe(401)
    expect(await live(me.id)).toBe(0)
  })

  it("matches the installation whatever its letter case", async () => {
    const me = await signedIn(PHONE.toUpperCase())
    expect((await refresh(me.refreshToken, PHONE)).status).toBe(200)
  })

  it("refuses a live token from another installation, and ends every session", async () => {
    const me = await signedIn(PHONE)
    expect((await refresh(me.refreshToken, OTHER)).status).toBe(401)
    expect(await live(me.id)).toBe(0)
  })

  // Security review: a session ended on purpose (a reset, sign-out everywhere) is dead, not stolen. Presenting its token
  // from anywhere must not end the sessions the person opened since.
  it("lets a deliberately ended session's token kill nothing newer", async () => {
    const me = await signedIn(PHONE)
    await db.mobile_refresh_tokens.updateMany({ where: { user_id: me.id }, data: { revoked_at: new Date(), revoked_reason: "signout_all" } })
    const user = await db.user.findUniqueOrThrow({ where: { id: me.id }, select: { email: true } })
    expect((await signinRoute.POST(post("/api/mobile/auth/signin", { email: user.email, password: PASSWORD, deviceInfo: { installationId: PHONE } }))).status).toBe(200)
    expect((await refresh(me.refreshToken)).status).toBe(401)
    expect(await live(me.id)).toBe(1)
  })

  it("accepts a replay as before for a session that recorded no installation", async () => {
    const me = await signedIn()
    expect((await refresh(me.refreshToken)).status).toBe(200)
    expect((await refresh(me.refreshToken, OTHER)).status).toBe(200)
    expect(await live(me.id)).toBe(1)
  })

  // Only a sign-in binds: a refresh naming an installation must not claim an unbound session, or a thief holding its
  // token could bind it to their phone first and have the owner's next replay treated as the theft.
  it("does not let a refresh bind a session that recorded none", async () => {
    const me = await signedIn()
    expect((await refresh(me.refreshToken, OTHER)).status).toBe(200)
    const rows = await db.mobile_refresh_tokens.findMany({ where: { user_id: me.id, revoked_at: null } })
    expect(rows.map((r) => (r.device_info as { installationId?: string } | null)?.installationId ?? null)).toEqual([null])
  })
})
