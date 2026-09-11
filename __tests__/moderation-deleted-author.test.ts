/*
 * The moderation queue names an erased author "Deleted account".
 *
 * Erasure keeps the flag (the message is still reviewable) and nulls the
 * name; the fallback was `name ?? email`, and the email an erased account
 * carries is `deleted-<id>@deleted.blendn.invalid`, which the queue rendered
 * as the author of every flag they ever raised.
 */
const mockDb = {
  moderation_flags: {
    findMany: jest.fn(),
    count: jest.fn().mockResolvedValue(1),
    groupBy: jest.fn().mockResolvedValue([{ status: "pending", _count: { _all: 1 } }]),
  },
  chat_messages: { count: jest.fn().mockResolvedValue(0) },
  photo_checks: { count: jest.fn().mockResolvedValue(0) },
}
jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("@/lib/auth", () => ({ getAuth: jest.fn().mockResolvedValue({ user: { id: "admin", role: "app_admin" } }) }))
jest.mock("@/lib/trust", () => ({ trustSignalsFor: jest.fn().mockResolvedValue(new Map()) }))

import { getModerationQueue } from "@/app/dashboard/moderation/actions"

function flag(user: { name: string | null; email: string; deletedAt: Date | null }) {
  return {
    id: "f1",
    created_at: new Date(),
    source: "auto_keyword",
    confidence: 0.9,
    categories: { contact_info: 0.9 },
    auto_action: "hidden",
    status: "pending",
    user_id: "u1",
    user,
    message: { id: "m1", content: "call me", deleted_at: null, chat_group: { event: { id: "e1", title: "Night" } } },
  }
}

describe("getModerationQueue author label", () => {
  it("an erased account reads 'Deleted account', not its placeholder address", async () => {
    mockDb.moderation_flags.findMany.mockResolvedValue([
      flag({ name: null, email: "deleted-abc@deleted.blendn.invalid", deletedAt: new Date() }),
    ])
    const rows = await getModerationQueue("pending")
    expect(rows.rows[0].authorName).toBe("Deleted account")
    expect(JSON.stringify(rows)).not.toContain("deleted.blendn.invalid")
  })

  it("a live account keeps its name", async () => {
    mockDb.moderation_flags.findMany.mockResolvedValue([flag({ name: "Kavya Nair", email: "k@x", deletedAt: null })])
    const rows = await getModerationQueue("pending")
    expect(rows.rows[0].authorName).toBe("Kavya Nair")
  })
})
