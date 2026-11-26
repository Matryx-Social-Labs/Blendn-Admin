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
jest.mock("@/lib/auth", () => ({ getAuth: async () => { const s = await session; return s?.user ? { ...s, user: { signedInAt: Date.now(), ...s.user } } : s } }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
jest.mock("@/lib/audit-log", () => {
  const actual = jest.requireActual("@/lib/audit-log")
  return { ...actual, auditInTx: jest.fn(actual.auditInTx) }
})

import { auditInTx } from "@/lib/audit-log"
import { updateUser, updateUserRole } from "@/app/dashboard/users/actions"
import { db as appDb } from "@/lib/db"
import { db, closeDb, testId } from "./helpers"

const users: string[] = []

beforeEach(() => jest.mocked(auditInTx).mockClear())

afterAll(async () => {
  if (users.length) {
    await db.audit_logs.deleteMany({ where: { resource_id: { in: users } } })
    await db.user.deleteMany({ where: { id: { in: users } } })
  }
  await closeDb()
})

async function person(email: string, role: "attendee" | "app_admin" = "attendee", emailVerified: Date | null = new Date()) {
  const id = testId("lock")
  await db.user.create({ data: { id, email: email.replace("@", `+${id.slice(-8)}@`), name: "Lock test", role, emailVerified } })
  users.push(id)
  return id
}

async function signedInAdmin() {
  const id = await person("lock-admin@matrixsociallabs.com", "app_admin")
  session = { user: { id, role: "app_admin" } }
  return id
}

async function anotherAdmin() {
  return person("lock-admin-b@matrixsociallabs.com", "app_admin")
}

const roleOf = async (id: string) => (await db.user.findUniqueOrThrow({ where: { id }, select: { role: true } })).role
const auditRows = (id: string) =>
  db.audit_logs.findMany({ where: { resource_id: id }, select: { action: true, details: true, user_id: true }, orderBy: { created_at: "asc" } })
const roleChanges = async (id: string) => (await auditRows(id)).filter((r) => r.action === "user.role_changed")
const stateOf = (id: string) =>
  db.user.findUniqueOrThrow({ where: { id }, select: { role: true, admin_requested_by: true, admin_requested_at: true } })
const NO_REQUEST = { role: "attendee", admin_requested_by: null, admin_requested_at: null }
const HOUR = 60 * 60 * 1000
/** A request recorded by `by` just now: `new Date()`, because some cases mock Date.now. */
async function expectFreshRequest(id: string, by: string) {
  const state = await stateOf(id)
  expect(state).toMatchObject({ role: "attendee", admin_requested_by: by })
  expect(Math.abs(state.admin_requested_at!.getTime() - new Date().getTime())).toBeLessThan(60_000)
}

describe("making someone an admin", () => {
  it("refuses an address off the company domain, and writes nothing", async () => {
    await signedInAdmin()
    const id = await person("x@gmail.com")

    await expect(updateUserRole(id, "app_admin")).rejects.toThrow("Only a verified @matrixsociallabs.com account can be an admin")

    expect(await roleOf(id)).toBe("attendee")
    expect(await auditRows(id)).toEqual([])
  })

  it("refuses a company address nobody has proven they own: app sign-up sends no verification mail", async () => {
    await signedInAdmin()
    const id = await person("claimed@matrixsociallabs.com", "attendee", null)

    await expect(updateUserRole(id, "app_admin")).rejects.toThrow("Only a verified @matrixsociallabs.com account can be an admin")

    expect(await roleOf(id)).toBe("attendee")
    expect(await auditRows(id)).toEqual([])
  })

  it("works for a company address once a second admin confirms, with exactly one role_changed row", async () => {
    const a = await signedInAdmin()
    const b = await anotherAdmin()
    const id = await person("x@matrixsociallabs.com")

    await updateUserRole(id, "app_admin")
    session = { user: { id: b, role: "app_admin" } }
    await updateUserRole(id, "app_admin")

    expect(await roleOf(id)).toBe("app_admin")
    expect(await roleChanges(id)).toEqual([
      { action: "user.role_changed", details: { from: "attendee", to: "app_admin", requestedBy: a, approvedBy: b }, user_id: b },
    ])
  })

  it("records nothing when the request's audit row cannot be written", async () => {
    await signedInAdmin()
    const id = await person("y@matrixsociallabs.com")
    jest.mocked(auditInTx).mockRejectedValueOnce(new Error("audit write failed"))

    await expect(updateUserRole(id, "app_admin")).rejects.toThrow("audit write failed")

    expect(auditInTx).toHaveBeenCalled()
    expect(await stateOf(id)).toEqual(NO_REQUEST)
    expect(await auditRows(id)).toEqual([])
  })

  it("fails closed when the address changed after it was checked", async () => {
    await signedInAdmin()
    const id = await person("race@matrixsociallabs.com")
    // The pre-read sees the company address; another admin re-addresses the row before the write.
    const read = appDb.user.findUnique.bind(appDb.user)
    const spy = jest.spyOn(appDb.user, "findUnique").mockImplementation((async (args: { where: { id?: string } }) => {
      const row = await read(args as never)
      if (args.where.id === id) await db.user.update({ where: { id }, data: { email: `race${id.slice(-8)}@gmail.com` } })
      return row
    }) as never)
    try {
      await expect(updateUserRole(id, "app_admin")).rejects.toThrow()
    } finally {
      spy.mockRestore()
    }

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
    // An erased admin row is not another admin.
    const erased = await person("erased@matrixsociallabs.com", "app_admin")
    await db.user.update({ where: { id: erased }, data: { deletedAt: new Date() } })
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

/*
 * Promotion to admin needs a second admin (SCRUM-1240, launch gate 10). The first
 * admin's save records a request; a different, live admin confirms it within 24 h.
 */
describe("a second admin", () => {
  const as = (id: string) => {
    session = { user: { id, role: "app_admin" } }
  }
  async function requested(by: string, at: Date) {
    const id = await person("p@matrixsociallabs.com")
    await db.user.update({ where: { id }, data: { admin_requested_by: by, admin_requested_at: at } })
    return id
  }

  it("A's save is a request: the role is unchanged, the request and one audit row are recorded", async () => {
    const a = await signedInAdmin()
    const id = await person("p@matrixsociallabs.com")

    await expect(updateUserRole(id, "app_admin")).resolves.toEqual({ success: true, pending: true })

    const state = await stateOf(id)
    expect(state).toMatchObject({ role: "attendee", admin_requested_by: a })
    expect(Math.abs(state.admin_requested_at!.getTime() - Date.now())).toBeLessThan(60_000)
    expect(await auditRows(id)).toEqual([{ action: "user.admin_promotion_requested", details: { to: "app_admin" }, user_id: a }])
  })

  it("refuses promoting someone who is already an admin, and records nothing", async () => {
    await signedInAdmin()
    const id = await anotherAdmin()

    await expect(updateUserRole(id, "app_admin")).rejects.toThrow("already an admin")

    expect(await stateOf(id)).toEqual({ role: "app_admin", admin_requested_by: null, admin_requested_at: null })
    expect(await auditRows(id)).toEqual([])
  })

  it("A confirming A's own request is still a request", async () => {
    const a = await signedInAdmin()
    const id = await person("p@matrixsociallabs.com")

    await updateUserRole(id, "app_admin")
    await expect(updateUserRole(id, "app_admin")).resolves.toEqual({ success: true, pending: true })

    expect(await stateOf(id)).toMatchObject({ role: "attendee", admin_requested_by: a })
    expect(await roleChanges(id)).toEqual([])
  })

  it("B confirming A's request makes the admin, clears the request, and the row names both", async () => {
    const a = await signedInAdmin()
    const b = await anotherAdmin()
    const id = await person("p@matrixsociallabs.com")

    await updateUserRole(id, "app_admin")
    as(b)
    await expect(updateUserRole(id, "app_admin")).resolves.toEqual({ success: true })

    expect(await stateOf(id)).toEqual({ role: "app_admin", admin_requested_by: null, admin_requested_at: null })
    expect(await auditRows(id)).toEqual([
      { action: "user.admin_promotion_requested", details: { to: "app_admin" }, user_id: a },
      { action: "user.role_changed", details: { from: "attendee", to: "app_admin", requestedBy: a, approvedBy: b }, user_id: b },
    ])
  })

  it("a request 25 h old has lapsed: A's save restarts it as A's own", async () => {
    const a = await signedInAdmin()
    const b = await anotherAdmin()
    const id = await requested(b, new Date(Date.now() - 25 * HOUR))

    await expect(updateUserRole(id, "app_admin")).resolves.toEqual({ success: true, pending: true })

    await expectFreshRequest(id, a)
    expect(await roleChanges(id)).toEqual([])
  })

  describe("the 24 h window (ADMIN_REQUEST_MS): a request exactly 24 h old has lapsed", () => {
    const at = new Date("2026-11-20T10:00:00.000Z")
    afterEach(() => jest.restoreAllMocks())

    it("1 ms short of 24 h it is confirmed", async () => {
      await signedInAdmin()
      const b = await anotherAdmin()
      const id = await requested(b, at)
      jest.spyOn(Date, "now").mockReturnValue(at.getTime() + 24 * HOUR - 1)

      await expect(updateUserRole(id, "app_admin")).resolves.toEqual({ success: true })
      expect(await roleOf(id)).toBe("app_admin")
    })

    it("at exactly 24 h it restarts as a request", async () => {
      const a = await signedInAdmin()
      const b = await anotherAdmin()
      const id = await requested(b, at)
      jest.spyOn(Date, "now").mockReturnValue(at.getTime() + 24 * HOUR)

      await expect(updateUserRole(id, "app_admin")).resolves.toEqual({ success: true, pending: true })
      await expectFreshRequest(id, a)
    })
  })

  describe("a requester who is no longer a live admin does not count: the save restarts as the approver's request", () => {
    it.each([
      ["demoted", { role: "organizer" as const }],
      ["suspended", { suspended_at: new Date() }],
      ["erased", { deletedAt: new Date() }],
    ])("%s", async (_, change) => {
      const a = await signedInAdmin()
      const b = await anotherAdmin()
      const id = await requested(b, new Date())
      await db.user.update({ where: { id: b }, data: change })

      await expect(updateUserRole(id, "app_admin")).resolves.toEqual({ success: true, pending: true })

      await expectFreshRequest(id, a)
      expect(await roleChanges(id)).toEqual([])
    })
  })

  it("refuses an approver who was suspended after signing in, checked inside the transaction", async () => {
    const a = await signedInAdmin()
    const b = await anotherAdmin()
    const id = await requested(a, new Date())
    as(b)
    // B passes requireAdmin; another admin suspends B before the write.
    const read = appDb.user.findUnique.bind(appDb.user)
    const spy = jest.spyOn(appDb.user, "findUnique").mockImplementation((async (args: { where: { id?: string } }) => {
      const row = await read(args as never)
      if (args.where.id === id) await db.user.update({ where: { id: b }, data: { suspended_at: new Date() } })
      return row
    }) as never)
    try {
      await expect(updateUserRole(id, "app_admin")).rejects.toThrow("Forbidden")
    } finally {
      spy.mockRestore()
    }

    expect(await stateOf(id)).toMatchObject({ role: "attendee", admin_requested_by: a })
    expect(await roleChanges(id)).toEqual([])
  })

  describe("a target that changed between the request and the approval is never promoted", () => {
    it("suspended since the request: refused", async () => {
      const a = await signedInAdmin()
      const b = await anotherAdmin()
      const id = await requested(a, new Date())
      await db.user.update({ where: { id }, data: { suspended_at: new Date() } })
      as(b)

      await expect(updateUserRole(id, "app_admin")).rejects.toThrow("A suspended account can't be made an admin")
      expect(await stateOf(id)).toMatchObject({ role: "attendee" })
      expect(await roleChanges(id)).toEqual([])
    })

    it("erased since the request: refused", async () => {
      const a = await signedInAdmin()
      const b = await anotherAdmin()
      const id = await requested(a, new Date())
      await db.user.update({ where: { id }, data: { deletedAt: new Date() } })
      as(b)

      await expect(updateUserRole(id, "app_admin")).rejects.toThrow("User not found")
      expect(await stateOf(id)).toMatchObject({ role: "attendee" })
      expect(await roleChanges(id)).toEqual([])
    })

    it.each([
      ["re-addressed", (id: string) => ({ email: `moved${id.slice(-8)}@gmail.com` })],
      ["suspended", () => ({ suspended_at: new Date() })],
      ["erased", () => ({ deletedAt: new Date() })],
    ])("%s after the approver's read, before the write: fails closed", async (_, change) => {
      const a = await signedInAdmin()
      const b = await anotherAdmin()
      const id = await requested(a, new Date())
      as(b)
      const read = appDb.user.findUnique.bind(appDb.user)
      const spy = jest.spyOn(appDb.user, "findUnique").mockImplementation((async (args: { where: { id?: string } }) => {
        const row = await read(args as never)
        if (args.where.id === id) await db.user.update({ where: { id }, data: change(id) })
        return row
      }) as never)
      try {
        await expect(updateUserRole(id, "app_admin")).rejects.toThrow()
      } finally {
        spy.mockRestore()
      }

      expect(await stateOf(id)).toMatchObject({ role: "attendee", admin_requested_by: a })
      expect(await roleChanges(id)).toEqual([])
    })
  })

  it("two admins confirming at the same moment make one admin and one role_changed row", async () => {
    const a = await signedInAdmin()
    const b = await anotherAdmin()
    const c = await anotherAdmin()
    const id = await requested(a, new Date())

    as(b)
    const first = updateUserRole(id, "app_admin")
    as(c)
    const second = updateUserRole(id, "app_admin")
    const results = await Promise.allSettled([first, second])

    expect(results.filter((r) => r.status === "fulfilled")).toEqual([{ status: "fulfilled", value: { success: true } }])
    expect(await stateOf(id)).toEqual({ role: "app_admin", admin_requested_by: null, admin_requested_at: null })
    expect(await roleChanges(id)).toHaveLength(1)
  })

  it("promotes nothing when the approval's audit row cannot be written", async () => {
    const a = await signedInAdmin()
    const b = await anotherAdmin()
    const id = await requested(a, new Date())
    as(b)
    jest.mocked(auditInTx).mockRejectedValueOnce(new Error("audit write failed"))

    await expect(updateUserRole(id, "app_admin")).rejects.toThrow("audit write failed")

    expect(auditInTx).toHaveBeenCalled()
    expect(await stateOf(id)).toMatchObject({ role: "attendee", admin_requested_by: a })
    expect(await auditRows(id)).toEqual([])
  })

  it("demotion needs no second admin, and leaves a request on another row alone", async () => {
    const a = await signedInAdmin()
    const b = await anotherAdmin()
    const pending = await requested(b, new Date())

    await expect(updateUserRole(b, "organizer")).resolves.toEqual({ success: true })

    expect(await roleOf(b)).toBe("organizer")
    expect(await roleChanges(b)).toEqual([{ action: "user.role_changed", details: { from: "app_admin", to: "organizer" }, user_id: a }])
    // Another row's request is untouched by it.
    expect(await stateOf(pending)).toMatchObject({ admin_requested_by: b })
  })

  it("a role change to anything but admin clears a pending request on that row", async () => {
    const a = await signedInAdmin()
    const id = await requested(a, new Date())

    await expect(updateUserRole(id, "organizer")).resolves.toEqual({ success: true })

    expect(await stateOf(id)).toEqual({ role: "organizer", admin_requested_by: null, admin_requested_at: null })
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

  it("re-saves a legacy admin address stored with a capital, lowercased, rather than refusing the edit", async () => {
    await signedInAdmin()
    const id = await person("Legacy@matrixsociallabs.com", "app_admin")
    const stored = (await db.user.findUniqueOrThrow({ where: { id } })).email

    await updateUser(id, { name: "Renamed", email: stored })

    expect(await db.user.findUniqueOrThrow({ where: { id } })).toMatchObject({ name: "Renamed", email: stored.toLowerCase() })
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

    await expect(updateUser(id, { name: "Not saved", email: `new${id.slice(-8)}@example.com` })).rejects.toThrow()

    expect(auditInTx).toHaveBeenCalled()
    expect(await db.user.findUniqueOrThrow({ where: { id } })).toMatchObject({ email: before, name: "Lock test" })
    expect(await auditRows(id)).toEqual([])
  })
})
