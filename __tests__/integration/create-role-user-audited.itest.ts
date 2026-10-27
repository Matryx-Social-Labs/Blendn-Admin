/*
 * Minting an operator account leaves an audit row (security audit 2026-10-24,
 * WEB L8): `createRoleUser` can create an `app_admin` and returns the plaintext
 * password, and wrote nothing. The row is written in the same transaction as the
 * account, and never carries the password.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
const mockGetAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: async () => { const s = await mockGetAuth(); return s?.user ? { ...s, user: { signedInAt: 0, ...s.user } } : s } }))

import { createRoleUser } from "@/lib/admin-role-actions"
import { cleanup, closeDb, db, makeUser, refusingWrites, testId } from "./helpers"

const users: string[] = []
afterAll(async () => {
  await db.audit_logs.deleteMany({ where: { user_id: { in: users } } })
  await cleanup(users, [])
  await closeDb()
})

it("writes user.created naming the admin, the new account and its role, and not the password", async () => {
  const admin = await makeUser(testId("cru_admin"), "app_admin")
  users.push(admin)
  mockGetAuth.mockResolvedValue({ user: { id: admin, role: "app_admin" } })

  const created = await createRoleUser("New Admin", `${testId("cru")}@itest.invalid`, "app_admin")
  const row = await db.user.findUniqueOrThrow({ where: { email: created.email }, select: { id: true } })
  users.push(row.id)

  const audit = await db.audit_logs.findFirstOrThrow({ where: { action: "user.created", resource_id: row.id } })
  expect(audit.user_id).toBe(admin)
  expect(audit.resource).toBe("user")
  expect(audit.details).toMatchObject({ role: "app_admin" })
  expect(JSON.stringify(audit)).not.toContain(created.password)
})

it("writes no account when its audit row cannot be written (one transaction)", async () => {
  const admin = await makeUser(testId("cru_admin2"), "app_admin")
  users.push(admin)
  mockGetAuth.mockResolvedValue({ user: { id: admin, role: "app_admin" } })
  const email = `${testId("cru_atomic")}@itest.invalid`
  await refusingWrites("audit_logs", "INSERT", `NEW.action = 'user.created' AND NEW.user_id = '${admin}'`, () =>
    expect(createRoleUser("Atomic", email, "organizer")).rejects.toThrow()
  )
  expect(await db.user.count({ where: { email } })).toBe(0)
})
