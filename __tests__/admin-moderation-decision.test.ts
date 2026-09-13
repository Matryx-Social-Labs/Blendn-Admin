/*
 * The admin's decision reaches the room, not only the database.
 *
 * `resolveFlag` wrote the message hidden and audited it, and the phones that
 * already had the room open kept showing the message until their next reload.
 * The auto-hide path has always emitted `chat:messageDeleted`; the human
 * decision now does too.
 */
const mockDb = {
  moderation_flags: { findUnique: jest.fn(), update: jest.fn() },
  chat_messages: { update: jest.fn() },
  $transaction: jest.fn(),
}
// The action runs its writes inside a transaction callback; hand it the same mocks.
mockDb.$transaction.mockImplementation(async (fn: (tx: typeof mockDb) => Promise<void>) => fn(mockDb))
const auditLog = jest.fn()
const emitChatMessageHidden = jest.fn()
jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("@/lib/audit-log", () => ({ auditLog }))
jest.mock("@/lib/socket-server", () => ({ emitChatMessageHidden }))
jest.mock("@/lib/trust", () => ({ trustSignalsFor: jest.fn() }))
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }))
jest.mock("@/lib/auth", () => ({ getAuth: jest.fn().mockResolvedValue({ user: { id: "admin", role: "app_admin" } }) }))

import { resolveFlag } from "@/app/dashboard/moderation/actions"

beforeEach(() => {
  jest.clearAllMocks()
  mockDb.moderation_flags.findUnique.mockResolvedValue({
    id: "f1", message_id: "m1", status: "pending", chat_group_id: "g1", user_id: "u9",
  })
})

describe("resolveFlag", () => {
  it("remove hides the message and tells the room", async () => {
    await resolveFlag("f1", "remove")
    expect(mockDb.chat_messages.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ moderation_status: "hidden" }) })
    )
    expect(emitChatMessageHidden).toHaveBeenCalledWith("g1", "m1", "u9")
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "moderation.message_removed" }))
  })

  it("keep restores the message and tells nobody", async () => {
    await resolveFlag("f1", "approve")
    expect(mockDb.chat_messages.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { moderation_status: "clean", deleted_at: null } })
    )
    expect(emitChatMessageHidden).not.toHaveBeenCalled()
  })
})
