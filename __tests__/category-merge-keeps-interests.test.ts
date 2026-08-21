/*
 * Merging a category must not destroy anybody's interests.
 *
 * `user_interests.category` is `onDelete: Cascade`. `mergeCategory` repointed
 * `event_categories` carefully — duplicate handling and all — and then deleted
 * the category, which took every user's interest in it with it. Silently, with
 * no warning and no undo.
 *
 * `lib/matching.ts` ranks on exactly that table. So one admin click quietly
 * degraded matching for everybody who had picked that category, and the only
 * visible effect was worse match cards, weeks later, with nothing to trace it
 * to. The admin screen made it worse by showing the event count and not the
 * interest count, so the number at stake was the one number they could not see.
 */

const tx = {
  event_categories: { findMany: jest.fn(), createMany: jest.fn(), deleteMany: jest.fn() },
  user_interests: { findMany: jest.fn(), createMany: jest.fn(), deleteMany: jest.fn() },
  categories: { delete: jest.fn() },
}

const mockDb = {
  categories: { findUniqueOrThrow: jest.fn(), findMany: jest.fn() },
  $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
}

jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("@/lib/audit-log", () => ({ auditLog: jest.fn() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
// `requireAdmin` is local to category-actions and reads the session, so the
// session is what gets mocked.
const mockAuth = jest.fn()
jest.mock("@/lib/auth", () => ({ getAuth: () => mockAuth() }))

import { mergeCategory } from "@/lib/category-actions"

const FROM = "11111111-1111-1111-1111-111111111111"
const INTO = "22222222-2222-2222-2222-222222222222"

beforeEach(() => {
  jest.clearAllMocks()
  mockAuth.mockResolvedValue({ user: { id: "admin1", role: "app_admin" } })
  mockDb.categories.findUniqueOrThrow
    .mockResolvedValueOnce({ name: "Techno", _count: { children: 0 } })
    .mockResolvedValueOnce({ name: "Electronic", parent_id: null })
  tx.event_categories.findMany.mockResolvedValue([])
  tx.user_interests.findMany.mockResolvedValue([])
})

describe("interests survive a merge", () => {
  it("repoints every interest onto the target", async () => {
    tx.user_interests.findMany
      .mockResolvedValueOnce([{ user_id: "u1" }, { user_id: "u2" }]) // held on `from`
      .mockResolvedValueOnce([]) // none already hold `into`

    await mergeCategory(FROM, INTO)

    expect(tx.user_interests.createMany).toHaveBeenCalledWith({
      data: [
        { user_id: "u1", category_id: INTO },
        { user_id: "u2", category_id: INTO },
      ],
    })
  })

  it("skips a user who already holds the target", async () => {
    /*
     * `@@unique([user_id, category_id])`. Without this the insert throws and
     * takes the whole merge down — the same trap the event links already
     * handled, on a table nobody had handled.
     */
    tx.user_interests.findMany
      .mockResolvedValueOnce([{ user_id: "u1" }, { user_id: "u2" }])
      .mockResolvedValueOnce([{ user_id: "u2" }])

    await mergeCategory(FROM, INTO)

    expect(tx.user_interests.createMany).toHaveBeenCalledWith({
      data: [{ user_id: "u1", category_id: INTO }],
    })
  })

  it("inserts nothing when everyone already holds the target", async () => {
    tx.user_interests.findMany
      .mockResolvedValueOnce([{ user_id: "u1" }])
      .mockResolvedValueOnce([{ user_id: "u1" }])

    await mergeCategory(FROM, INTO)

    expect(tx.user_interests.createMany).not.toHaveBeenCalled()
  })

  it("copies before it deletes", async () => {
    /*
     * Order is the whole fix. The category delete cascades to
     * `user_interests`, so a repoint that ran afterwards would repoint rows
     * that no longer exist.
     */
    tx.user_interests.findMany
      .mockResolvedValueOnce([{ user_id: "u1" }])
      .mockResolvedValueOnce([])

    await mergeCategory(FROM, INTO)

    const copiedAt = tx.user_interests.createMany.mock.invocationCallOrder[0]
    const deletedAt = tx.categories.delete.mock.invocationCallOrder[0]
    expect(copiedAt).toBeLessThan(deletedAt)
  })

  it("reports how many interests moved, not just events", async () => {
    /*
     * The count is the evidence. An admin who merges and is told only about
     * events cannot tell whether the thing that used to be destroyed was.
     */
    tx.event_categories.findMany.mockResolvedValueOnce([{ event_id: "e1", primary: false }])
    tx.event_categories.findMany.mockResolvedValueOnce([])
    tx.user_interests.findMany
      .mockResolvedValueOnce([{ user_id: "u1" }, { user_id: "u2" }])
      .mockResolvedValueOnce([])

    expect(await mergeCategory(FROM, INTO)).toEqual({ events: 1, interests: 2 })
  })
})
