/*
 * The organiser's moderation decision changes what the room can see, both ways.
 *
 * Reject used to update the flag and nothing else. Only flags above the
 * auto-hide threshold arrive hidden, so rejecting a 62% flag left the message
 * on every phone while the button said "Keep Hidden". And neither branch wrote
 * to `audit_logs`, while the admin twin always has.
 */
const mockDb = {
  events: { findUnique: jest.fn() },
  moderation_flags: { findFirst: jest.fn(), update: jest.fn((args) => ({ __op: "flag", args })) },
  chat_messages: { update: jest.fn((args) => ({ __op: "message", args })) },
  $transaction: jest.fn().mockResolvedValue([]),
}
const auditLog = jest.fn()
jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("@/lib/audit-log", () => ({ auditLog }))
jest.mock("@/lib/auth", () => ({ getAuth: jest.fn().mockResolvedValue({ user: { id: "arjun", role: "organizer" } }) }))
jest.mock("@/lib/org-membership", () => ({ actorFor: jest.fn().mockResolvedValue({ id: "arjun", role: "organizer", orgIds: ["org1"] }) }))
jest.mock("@/lib/rbac", () => ({ eventPermissions: () => ({ canEdit: true, canOperate: true }) }))
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn() } }))

import { PATCH } from "@/app/api/events/[id]/chat/moderation/[flagId]/route"

function req(action: "approve" | "reject") {
  return new Request("http://x/api/events/e1/chat/moderation/f1", {
    method: "PATCH",
    body: JSON.stringify({ action }),
    headers: { "content-type": "application/json" },
  }) as never
}
const params = Promise.resolve({ id: "e1", flagId: "f1" })

beforeEach(() => {
  jest.clearAllMocks()
  mockDb.events.findUnique.mockResolvedValue({
    id: "e1", organizer_org_id: "org1", venue: null, chat_group: { id: "g1" },
  })
})

function messageWrite() {
  const [ops] = mockDb.$transaction.mock.calls[0]
  return (ops as { __op: string; args: { data: Record<string, unknown> } }[]).find((o) => o.__op === "message")!.args.data
}

describe("PATCH /api/events/[id]/chat/moderation/[flagId]", () => {
  it("reject hides a message that was never auto-hidden", async () => {
    mockDb.moderation_flags.findFirst.mockResolvedValue({
      id: "f1", message_id: "m1", status: "pending", message: { deleted_at: null },
    })
    const res = await PATCH(req("reject"), { params })
    expect(res.status).toBe(200)
    expect(messageWrite()).toMatchObject({ moderation_status: "hidden" })
    expect(messageWrite().deleted_at).toBeInstanceOf(Date)
  })

  it("reject keeps the original deleted_at on a message that was already hidden", async () => {
    const hiddenAt = new Date("2026-09-01T00:00:00Z")
    mockDb.moderation_flags.findFirst.mockResolvedValue({
      id: "f1", message_id: "m1", status: "pending", message: { deleted_at: hiddenAt },
    })
    await PATCH(req("reject"), { params })
    expect(messageWrite()).toEqual({ moderation_status: "hidden" })
  })

  it("approve restores, and both branches leave an audit row", async () => {
    mockDb.moderation_flags.findFirst.mockResolvedValue({
      id: "f1", message_id: "m1", status: "pending", message: { deleted_at: new Date() },
    })
    await PATCH(req("approve"), { params })
    expect(messageWrite()).toEqual({ moderation_status: "clean", deleted_at: null })
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({
      userId: "arjun", action: "moderation.flag_approved", resource: "moderation_flag", resourceId: "f1",
    }))

    await PATCH(req("reject"), { params })
    expect(auditLog).toHaveBeenLastCalledWith(expect.objectContaining({ action: "moderation.message_removed" }))
  })
})
