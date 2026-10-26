import bcrypt from "bcryptjs"
import type { DashboardRole } from "@/lib/dashboard-types"

/*
 * The admin Users screen never sends a password hash, a birth date or a
 * suspension note to the browser (security audit 2026-10-24, WEB M2).
 *
 * `getUsers` used `include`, which returns every scalar on `User`, and
 * `updateUser` returned the updated row with its whole profile. The result goes
 * into the RSC payload / action response, so anything that can read an admin's
 * page read up to fifty bcrypt hashes and the dates of birth `getUsers` strips
 * on purpose. Real actions, real rows; the serialised result is what is searched.
 */
let session: { user: { id: string; role: DashboardRole } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: async () => { const s = await session; return s?.user ? { ...s, user: { signedInAt: 0, ...s.user } } : s } }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { getUsers, updateUser } from "@/app/dashboard/users/actions"
import { db, closeDb, makeUser, testId } from "./helpers"

const users: string[] = []
afterAll(async () => {
  await db.audit_logs.deleteMany({ where: { resource_id: { in: users } } })
  await db.profiles.deleteMany({ where: { id: { in: users } } })
  await db.user.deleteMany({ where: { id: { in: users } } })
  await closeDb()
})

async function target() {
  const adminId = await makeUser(testId("nosec-admin"), "app_admin")
  const id = await makeUser(testId("nosec-user"), "attendee")
  users.push(adminId, id)
  session = { user: { id: adminId, role: "app_admin" } }
  const hash = await bcrypt.hash("never-leaves-the-server", 4)
  await db.user.update({ where: { id }, data: { password: hash, suspension_reason: "private moderator note" } })
  await db.profiles.create({ data: { id, name: "Target", age: 30, date_of_birth: new Date("1990-04-05T00:00:00Z") } })
  return { id, hash }
}

it("getUsers carries no password hash, birth date or suspension note", async () => {
  const { id, hash } = await target()
  const { users: listed } = await getUsers(id)
  expect(listed.map((u) => u.id)).toContain(id)
  const wire = JSON.stringify(listed)
  expect(wire).not.toContain(hash)
  expect(wire).not.toContain("private moderator note")
  expect(wire).not.toContain("1990-04-05")
  expect(listed.find((u) => u.id === id)).not.toHaveProperty("password")
})

it("updateUser returns none of them either, and still saves the edit", async () => {
  const { id, hash } = await target()
  const result = await updateUser(id, { name: "Renamed", profile: { location: "Bengaluru" } })
  expect(result).toEqual({ success: true })
  const wire = JSON.stringify(result)
  expect(wire).not.toContain(hash)
  expect(wire).not.toContain("1990-04-05")
  expect((await db.user.findUniqueOrThrow({ where: { id } })).name).toBe("Renamed")
})
