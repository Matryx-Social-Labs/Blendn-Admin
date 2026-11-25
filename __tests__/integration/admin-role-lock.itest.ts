import type { DashboardRole } from "@/lib/dashboard-types"

/*
 * The admin role is locked (SCRUM-1235, launch gate 10).
 *
 * Any admin could make any account an `app_admin` in one click, demote the
 * last one, and change any account's email (then request a reset: a takeover).
 * The role-change audit was fire-and-forget, so a failed write left only a log
 * line. And an email typed with a capital letter was stored as typed while
 * sign-in looks it up lowercased, locking the person out.
 *
 * Real actions against a `db:migrate` database, rows read back. The audit row
 * is read without polling: it commits with the change or not at all.
 */
let session: { user: { id: string; role: DashboardRole } } | null = null
jest.mock("@/lib/auth", () => ({ getAuth: async () => { const s = await session; return s?.user ? { ...s, user: { signedInAt: 0, ...s.user } } : s } }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
jest.mock("@/lib/audit-log", () => {
  const actual = jest.requireActual("@/lib/audit-log")
  return { ...actual, auditInTx: jest.fn(actual.auditInTx) }
})

import { auditInTx } from "@/lib/audit-log"
import { updateUser, updateUserRole } from "@/app/dashboard/users/actions"
import { db, closeDb, testId } from "./helpers"

const users: string[] = []

afterAll(async () => {
  if (users.length) {
    await db.audit_logs.deleteMany({ where: { resource_id: { in: users } } })
    await db.user.deleteMany({ where: { id: { in: users } } })
  }
  await closeDb()
})

async function person(email: string, role: "attendee" | "app_admin" = "attendee") {
  const id = testId("lock")
  await db.user.create({ data: { id, email: email.replace("@", `+${id.slice(-8)}@`), name: "Lock test", role } })
  users.push(id)
  return id
}

async function signedInAdmin() {
  const id = await person("lock-admin@matrixsociallabs.com", "app_admin")
  session = { user: { id, role: "app_admin" } }
  return id
}

const roleOf = async (id: string) => (await db.user.findUniqueOrThrow({ where: { id }, select: { role: true } })).role
const auditRows = (id: string) => db.audit_logs.findMany({ where: { resource_id: id }, select: { action: true, details: true, user_id: true } })

describe("making someone an admin", () => {
  it("refuses an address off the company domain, and writes nothing", async () => {
    await signedInAdmin()
    const id = await person("x@gmail.com")

    await expect(updateUserRole(id, "app_admin")).rejects.toThrow("Only @matrixsociallabs.com accounts can be admins")

    expect(await roleOf(id)).toBe("attendee")
    expect(await auditRows(id)).toEqual([])
  })

  it("works for a company address, with exactly one role_changed row", async () => {
    const adminId = await signedInAdmin()
    const id = await person("x@matrixsociallabs.com")

    await updateUserRole(id, "app_admin")

    expect(await roleOf(id)).toBe("app_admin")
    expect(await auditRows(id)).toEqual([{ action: "user.role_changed", details: { from: "attendee", to: "app_admin" }, user_id: adminId }])
  })

  it("changes nothing when the audit row cannot be written", async () => {
    await signedInAdmin()
    const id = await person("y@matrixsociallabs.com")
    jest.mocked(auditInTx).mockRejectedValueOnce(new Error("audit write failed"))

    await expect(updateUserRole(id, "app_admin")).rejects.toThrow()

    expect(await roleOf(id)).toBe("attendee")
    expect(await auditRows(id)).toEqual([])
  })
})

describe("the last admin", () => {
  it("cannot be demoted", async () => {
    const adminId = await signedInAdmin()
    // Every other live admin in this shared database, suspended for the case and put back by id.
    const others = await db.user.findMany({
      where: { role: "app_admin", deletedAt: null, suspended_at: null, id: { not: adminId } },
      select: { id: true },
    })
    const otherIds = others.map((u) => u.id)
    await db.user.updateMany({ where: { id: { in: otherIds } }, data: { suspended_at: new Date() } })
    try {
      await expect(updateUserRole(adminId, "organizer")).rejects.toThrow("This is the last admin")
      expect(await roleOf(adminId)).toBe("app_admin")
    } finally {
      await db.user.updateMany({ where: { id: { in: otherIds } }, data: { suspended_at: null } })
    }
  })

  it("can be demoted once there is another", async () => {
    const adminId = await signedInAdmin()
    const second = await person("z@matrixsociallabs.com", "app_admin")

    await updateUserRole(second, "organizer")

    expect(await roleOf(second)).toBe("organizer")
    expect(await roleOf(adminId)).toBe("app_admin")
  })
})

describe("editing an email", () => {
  it("stores it the way sign-in looks it up: trimmed and lowercased", async () => {
    await signedInAdmin()
    const id = await person("before@example.com")
    const typed = ` A${id.slice(-8)}@Example.com `

    await updateUser(id, { email: typed })

    expect((await db.user.findUniqueOrThrow({ where: { id } })).email).toBe(typed.trim().toLowerCase())
    const [row] = await auditRows(id)
    expect(row).toMatchObject({ action: "user.updated", details: { changed: { email: { to: typed.trim().toLowerCase() } } } })
  })

  it("refuses a change on an admin's row", async () => {
    await signedInAdmin()
    const id = await person("other-admin@matrixsociallabs.com", "app_admin")
    const before = (await db.user.findUniqueOrThrow({ where: { id } })).email

    await expect(updateUser(id, { email: "attacker@example.com" })).rejects.toThrow("An admin's email can't be changed")

    expect((await db.user.findUniqueOrThrow({ where: { id } })).email).toBe(before)
    expect(await auditRows(id)).toEqual([])
  })

  it("lets an admin's row save with its email unchanged", async () => {
    await signedInAdmin()
    const id = await person("same@matrixsociallabs.com", "app_admin")
    const email = (await db.user.findUniqueOrThrow({ where: { id } })).email

    await updateUser(id, { name: "Renamed", email })

    expect((await db.user.findUniqueOrThrow({ where: { id } })).name).toBe("Renamed")
  })

  it("refuses moving an account onto the company domain, which would let it be made an admin", async () => {
    await signedInAdmin()
    const id = await person("someone@gmail.com")

    await expect(updateUser(id, { email: `someone${id.slice(-8)}@matrixsociallabs.com` })).rejects.toThrow(
      "can't be set from the dashboard"
    )
    expect(await auditRows(id)).toEqual([])
  })

  it("changes nothing when the audit row cannot be written", async () => {
    await signedInAdmin()
    const id = await person("audit@example.com")
    const before = (await db.user.findUniqueOrThrow({ where: { id } })).email
    jest.mocked(auditInTx).mockRejectedValueOnce(new Error("audit write failed"))

    await expect(updateUser(id, { email: `new${id.slice(-8)}@example.com` })).rejects.toThrow()

    expect((await db.user.findUniqueOrThrow({ where: { id } })).email).toBe(before)
  })
})
