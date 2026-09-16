import type { DashboardRole } from "@/lib/dashboard-types"

/*
 * The admin's Users screen: the age it shows is the age the product enforces,
 * the age cannot be edited out from under a birth date, and every admin edit
 * leaves an audit row.
 *
 * Found on staging (SCRUM-131): an admin set a 30-year-old's age to 17, the
 * list said "17 years old", and the product still admitted her to an 18+ event
 * — `ageFrom` makes the birth date win everywhere else. And neither that edit
 * nor a role change wrote to `audit_logs`, the one action CLAUDE.md names as
 * canonically audited. Real actions against real Postgres, rows read back.
 */
let session: { user: { id: string; role: DashboardRole } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: () => Promise.resolve(session) }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { getUsers, updateUser, updateUserRole } from "@/app/dashboard/users/actions"
import { db, closeDb, makeUser, testId } from "./helpers"

const users: string[] = []

afterAll(async () => {
  if (users.length) {
    await db.audit_logs.deleteMany({ where: { resource_id: { in: users } } })
    await db.profiles.deleteMany({ where: { id: { in: users } } })
    await db.user.deleteMany({ where: { id: { in: users } } })
  }
  await closeDb()
})

const yearsAgo = (n: number) => {
  const d = new Date()
  d.setFullYear(d.getFullYear() - n)
  return d
}

/** `auditLog` is fire-and-forget; give the row a moment to land. */
async function auditRow(where: { resource_id: string; action: string }) {
  for (let i = 0; i < 40; i++) {
    const row = await db.audit_logs.findFirst({ where, orderBy: { created_at: "desc" } })
    if (row) return row
    await new Promise((r) => setTimeout(r, 50))
  }
  return null
}

async function admin() {
  const id = await makeUser(testId("aua-admin"), "app_admin")
  users.push(id)
  session = { user: { id, role: "app_admin" } }
  return id
}

describe("a person with a birth date", () => {
  it("is listed at the age the product enforces, not the number typed at sign-up", async () => {
    await admin()
    const id = await makeUser(testId("aua-dob"), "attendee")
    users.push(id)
    // Typed 25 at sign-up; the birth date says 17. Exactly the Android drive.
    await db.profiles.create({ data: { id, name: "Typed 25", age: 25, date_of_birth: yearsAgo(17) } })

    const { users: listed } = await getUsers(id)
    const row = listed.find((u) => u.id === id)
    expect(row?.profile).toMatchObject({ age: 17, ageFromBirthDate: true })
    // The date itself stays on the server.
    expect(row?.profile).not.toHaveProperty("date_of_birth", expect.anything())
  })

  it("cannot have the age edited out from under the birth date, and the refusal says why", async () => {
    const adminId = await admin()
    const id = await makeUser(testId("aua-dob2"), "attendee")
    users.push(id)
    await db.profiles.create({ data: { id, name: "Thirty", age: 30, date_of_birth: yearsAgo(30) } })

    await expect(updateUser(id, { profile: { age: 17 } })).rejects.toThrow(
      "Their age comes from their birth date and cannot be edited here."
    )
    const after = await db.profiles.findUniqueOrThrow({ where: { id } })
    expect(after.age).toBe(30)
    await new Promise((r) => setTimeout(r, 200))
    expect(await db.audit_logs.count({ where: { resource_id: id, user_id: adminId } })).toBe(0)
  })
})

describe("every admin edit is accountable", () => {
  it("writes user.updated with what changed", async () => {
    const adminId = await admin()
    const id = await makeUser(testId("aua-edit"), "attendee")
    users.push(id)
    await db.profiles.create({ data: { id, name: "Before", age: 22 } })

    await updateUser(id, { name: "After", profile: { age: 23, onboarded: true } })

    const row = await auditRow({ resource_id: id, action: "user.updated" })
    expect(row?.user_id).toBe(adminId)
    expect(row?.details).toMatchObject({
      changed: { name: { from: expect.any(String), to: "After" }, age: { from: 22, to: 23 }, onboarded: { from: false, to: true } },
    })
  })

  it("writes user.role_changed with from and to", async () => {
    const adminId = await admin()
    const id = await makeUser(testId("aua-role"), "attendee")
    users.push(id)

    await updateUserRole(id, "organizer")

    expect((await db.user.findUniqueOrThrow({ where: { id } })).role).toBe("organizer")
    const row = await auditRow({ resource_id: id, action: "user.role_changed" })
    expect(row?.user_id).toBe(adminId)
    expect(row?.details).toEqual({ from: "attendee", to: "organizer" })
  })
})
