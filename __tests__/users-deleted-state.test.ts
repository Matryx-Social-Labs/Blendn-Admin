import { readFileSync } from "fs"
import { join } from "path"

/**
 * A deleted account on /dashboard/users.
 *
 * Erasure keeps the row — name null, `deleted-<id>@…invalid`, `deletedAt` set,
 * FKs preserved so other people's history survives. The screen rendered that
 * row as "Unnamed User · deleted-cmtw…@deleted.blendn.invalid · Unverified ·
 * Attendee" with the same Edit menu as a live account, counted it in
 * "accounts", and had no way to list only the erased ones. Three admins use
 * this screen to answer "is this person on the platform" and, for a GDPR
 * request, "was it done, and when". It answered neither.
 *
 * The query half is exercised behaviourally through the action with the
 * database mocked, because the bug is in the `where`. The table half is pinned
 * as source text, because what matters is which branch a deleted row takes.
 */
const mockDb = {
  user: { findMany: jest.fn(), count: jest.fn() },
  profiles: { count: jest.fn() },
}
const mockAuth = jest.fn()
jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("@/lib/auth", () => ({ getAuth: () => mockAuth() }))
jest.mock("@/lib/location", () => ({ normalizeLocationToCity: jest.fn(async (s: string) => s) }))
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))

import { getUsers, getUserStats } from "@/app/dashboard/users/actions"

const ROOT = join(__dirname, "..")
const read = (rel: string) =>
  readFileSync(join(ROOT, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")

beforeEach(() => {
  jest.clearAllMocks()
  mockAuth.mockResolvedValue({ user: { id: "admin", role: "app_admin" } })
  mockDb.user.findMany.mockResolvedValue([])
  mockDb.user.count.mockResolvedValue(0)
  mockDb.profiles.count.mockResolvedValue(0)
})

const whereOf = (call: jest.Mock) => call.mock.calls[0][0].where as { AND: Record<string, unknown>[] }

describe("the list", () => {
  it("shows live accounts by default — a deleted row is not somebody on the platform", async () => {
    await getUsers()
    const { AND } = whereOf(mockDb.user.findMany)
    expect(AND).toContainEqual({ deletedAt: null })
    // The count footer describes the same set the list shows.
    expect(mockDb.user.count.mock.calls[0][0].where).toEqual({ AND })
  })

  it("lists only deleted accounts when asked", async () => {
    await getUsers(undefined, "deleted")
    const { AND } = whereOf(mockDb.user.findMany)
    expect(AND).toContainEqual({ deletedAt: { not: null } })
    expect(AND).not.toContainEqual({ deletedAt: null })
  })

  it("finds the suspended accounts the stats line counts", async () => {
    await getUsers(undefined, "suspended")
    expect(whereOf(mockDb.user.findMany).AND).toContainEqual({ suspended_at: { not: null } })
  })

  it("keeps a search when combined with the not-onboarded filter", async () => {
    // Both used to assign `where.OR`; the second replaced the first.
    await getUsers("priya", "not-onboarded")
    const { AND } = whereOf(mockDb.user.findMany)
    const ors = AND.filter((c) => "OR" in c)
    expect(ors).toHaveLength(2)
    expect(JSON.stringify(ors)).toContain("priya")
    expect(JSON.stringify(ors)).toContain("onboarded")
  })
})

describe("the stats line", () => {
  it("counts people on the platform, and says how many were erased", async () => {
    mockDb.user.count
      .mockResolvedValueOnce(119) // live
      .mockResolvedValueOnce(40) // verified
      .mockResolvedValueOnce(1) // suspended
      .mockResolvedValueOnce(2) // deleted
    mockDb.profiles.count.mockResolvedValue(76)
    const stats = await getUserStats()
    expect(stats).toEqual({ total: 119, onboarded: 76, verified: 40, suspended: 1, deleted: 2 })
    const wheres = mockDb.user.count.mock.calls.map((c) => c[0].where)
    expect(wheres[0]).toEqual({ deletedAt: null })
    expect(wheres[1]).toMatchObject({ deletedAt: null })
    expect(wheres[2]).toMatchObject({ deletedAt: null })
    expect(wheres[3]).toEqual({ deletedAt: { not: null } })
    expect(mockDb.profiles.count.mock.calls[0][0].where).toMatchObject({ user: { deletedAt: null } })
  })

  it("renders the erased count only when there is one", () => {
    const page = read("app/dashboard/users/page.tsx")
    expect(page).toMatch(/stats\.deleted > 0 \? \(/)
    expect(page).toMatch(/\{stats\.deleted\.toLocaleString\(\)\}<\/span> deleted/)
  })
})

describe("the row", () => {
  const table = read("app/dashboard/users/users-table.tsx")

  it("is the receipt: the date it was done and the id, not 'Unnamed User' and a fake address", () => {
    const userCell = table.slice(table.indexOf('accessorKey: "user"'), table.indexOf('accessorKey: "status"'))
    const branch = userCell.indexOf("if (user.deletedAt)")
    expect(branch).toBeGreaterThan(-1)
    expect(userCell.slice(branch)).toMatch(/Deleted \{format\(new Date\(user\.deletedAt\), "d MMM yyyy"\)\}/)
    expect(userCell.slice(branch)).toMatch(/\{user\.id\}/)
    // The deleted branch returns before the fallback name is reached.
    expect(branch).toBeLessThan(userCell.indexOf('"Unnamed User"'))
  })

  it("carries one chip — Deleted — and none of the live-account chips", () => {
    const statusCell = table.slice(table.indexOf('accessorKey: "status"'), table.indexOf('accessorKey: "role"'))
    const branch = statusCell.indexOf("if (user.deletedAt)")
    expect(branch).toBeGreaterThan(-1)
    expect(branch).toBeLessThan(statusCell.indexOf('"Verified" : "Unverified"'))
    expect(statusCell.slice(branch, statusCell.indexOf("const isVerified"))).toMatch(/>\s*Deleted\s*</)
  })

  it("has no action menu — there is nothing on it to edit", () => {
    expect(table).toMatch(/row\.original\.deletedAt \? null : <ActionsCell/)
  })

  it("can be asked for from the status filter", () => {
    expect(table).toMatch(/<SelectItem value="deleted">Deleted<\/SelectItem>/)
    expect(table).toMatch(/if \(value === "all"\) next\.delete\("status"\)/)
  })
})
