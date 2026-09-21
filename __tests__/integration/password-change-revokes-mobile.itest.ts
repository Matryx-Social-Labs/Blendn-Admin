import { NextRequest } from "next/server"
import bcrypt from "bcryptjs"

/*
 * Changing your password from Settings ends every phone session (SCRUM-169).
 *
 * Driven on staging as Priya: hash changed, audit written, and the five
 * mobile refresh tokens were five before and five after. The reset-link path
 * had always revoked them, with the reason in its comment; this path is the
 * same person doing the same thing and kept the attacker's phone alive for
 * up to thirty days. Real action, real tokens, the real refresh route.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
const mockAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: () => mockAuth() }))

import { changePassword } from "@/lib/account-actions"
import { signRefreshToken, storeRefreshToken } from "@/lib/mobile-auth"
import { cleanup, closeDb, db, makeUser } from "./helpers"
// eslint-disable-next-line @typescript-eslint/no-require-imports
const route = require("@/app/api/mobile/auth/refresh/route") as typeof import("@/app/api/mobile/auth/refresh/route")

const users: string[] = []
afterAll(async () => {
  await cleanup(users, [])
  await closeDb()
})

const refresh = (refreshToken: string) =>
  route.POST(
    new NextRequest("http://localhost/api/mobile/auth/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    })
  )

it("revokes every live mobile session with the hash, and the phone's next refresh is refused", async () => {
  // An attendee: the app is attendees-only (SCRUM-198), so a staff phone token
  // is refused before this revoke could be the reason — which would make the
  // control below vacuous. The action itself does not care who is changing.
  const id = await makeUser("pw-change")
  users.push(id)
  const { email } = await db.user.update({
    where: { id },
    data: { password: await bcrypt.hash("Old-Password-2026!", 12) },
    select: { email: true },
  })
  mockAuth.mockResolvedValue({ user: { id, email, role: "attendee" } })

  // One session that had already ended and must stay as it was, then two phones.
  const earlier = signRefreshToken(id, email)
  await storeRefreshToken(id, earlier)
  const phone1 = signRefreshToken(id, email)
  const phone2 = signRefreshToken(id, email)
  await storeRefreshToken(id, phone1)
  await storeRefreshToken(id, phone2)
  // Stored before the two phones, so it is the oldest row for this user.
  const earlierRevokedAt = new Date(Date.now() - 60_000)
  const oldest = await db.mobile_refresh_tokens.findFirstOrThrow({
    where: { user_id: id },
    orderBy: { created_at: "asc" },
    select: { id: true },
  })
  await db.mobile_refresh_tokens.update({ where: { id: oldest.id }, data: { revoked_at: earlierRevokedAt } })

  const result = await changePassword("Old-Password-2026!", "orchard-lantern-quiet-42")
  expect(result).toEqual({ ok: true, revokedSessions: 2 })

  const rows = await db.mobile_refresh_tokens.findMany({
    where: { user_id: id },
    select: { revoked_at: true },
  })
  expect(rows).toHaveLength(3)
  expect(rows.every((r) => r.revoked_at !== null)).toBe(true)
  // The earlier revocation keeps its own timestamp — not re-stamped as now.
  expect(rows.some((r) => r.revoked_at!.getTime() === earlierRevokedAt.getTime())).toBe(true)

  // The phone tries to carry on. It cannot.
  expect((await refresh(phone1)).status).toBe(401)
  expect((await refresh(phone2)).status).toBe(401)

  // And the new password is the one that works.
  const { password } = await db.user.findUniqueOrThrow({ where: { id }, select: { password: true } })
  expect(await bcrypt.compare("orchard-lantern-quiet-42", password!)).toBe(true)
})

it("revokes nothing, and says so, when the current password is wrong", async () => {
  const id = await makeUser("pw-change-wrong")
  users.push(id)
  const { email } = await db.user.update({
    where: { id },
    data: { password: await bcrypt.hash("Old-Password-2026!", 12) },
    select: { email: true },
  })
  mockAuth.mockResolvedValue({ user: { id, email, role: "attendee" } })
  const phone = signRefreshToken(id, email)
  await storeRefreshToken(id, phone)

  const result = await changePassword("not-it", "orchard-lantern-quiet-42")
  expect(result.ok).toBe(false)
  expect(result.revokedSessions).toBeUndefined()
  expect((await refresh(phone)).status).toBe(200)
})
