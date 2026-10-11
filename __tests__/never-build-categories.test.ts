/*
 * A category is an interest people hold and a filter events carry, so naming
 * one is where a caste, faith or diet proxy would arrive without a deploy
 * (plan v2 §8.4; step 10 review M5). Create and rename refuse it at runtime,
 * with the same list the build-time guard reads (`lib/never-build.ts`).
 */
const mockDb = {
  categories: {
    findUniqueOrThrow: jest.fn(),
    findUnique: jest.fn().mockResolvedValue(null),
    findFirst: jest.fn().mockResolvedValue(null),
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({ id: "c1" }),
    update: jest.fn(),
  },
  // requireAdmin reads the caller's row (lib/current-user.ts): a live admin.
  user: { findUnique: jest.fn(async () => ({ role: "app_admin", suspended_at: null, deletedAt: null, password_changed_at: null, sessions_revoked_at: null })) },
}
jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("@/lib/audit-log", () => ({ auditLog: jest.fn() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
const mockAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: async () => { const s = await mockAuth(); return s?.user ? { ...s, user: { signedInAt: 0, ...s.user } } : s } }))

import { createCategory, renameCategory } from "@/lib/category-actions"
import { neverBuildHits } from "@/lib/never-build"

beforeEach(() => {
  jest.clearAllMocks()
  mockAuth.mockResolvedValue({ user: { id: "admin1", role: "app_admin" } })
  mockDb.categories.findUniqueOrThrow.mockResolvedValue({ name: "Old name", parent_id: null })
})

describe("the list reads labels the way people write them", () => {
  it("catches a word, two words run together, and any case", () => {
    expect(neverBuildHits("Pure Veg")).toEqual(["veg"])
    expect(neverBuildHits("Non veg nights")).toEqual(expect.arrayContaining(["veg", "nonveg"]))
    expect(neverBuildHits("Jain food")).toEqual(["jain"])
    expect(neverBuildHits("HALAL grills")).toEqual(["halal"])
    expect(neverBuildHits("Brahmin samaj")).toEqual(["brahmin"])
    expect(neverBuildHits("College alumni")).toEqual(["college"])
  })
  it("leaves words that only contain one alone", () => {
    expect(neverBuildHits("Vegetables and farming")).toEqual([])
    expect(neverBuildHits("Community hall gigs")).toEqual([])
    expect(neverBuildHits("Street food")).toEqual([])
  })
})

describe("create and rename refuse it (M5)", () => {
  it("refuses to create one, and writes nothing", async () => {
    await expect(createCategory("Pure Veg", null)).rejects.toThrow(/can't be a category/)
    await expect(createCategory("Halal grills", null)).rejects.toThrow(/can't be a category/)
    expect(mockDb.categories.create).not.toHaveBeenCalled()
  })
  it("refuses to rename into one, and writes nothing", async () => {
    await expect(renameCategory("11111111-1111-1111-1111-111111111111", "Jain thali")).rejects.toThrow(/can't be a category/)
    expect(mockDb.categories.update).not.toHaveBeenCalled()
  })
  it("lets an ordinary one through", async () => {
    await createCategory("Bakeries", null)
    expect(mockDb.categories.create).toHaveBeenCalled()
  })
})
