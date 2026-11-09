/*
 * The moderation queue's excerpt is cut between graphemes (SCRUM-1033).
 *
 * It was `content.slice(0, 140)`: 140 UTF-16 units, so a message with an emoji
 * across the cut left a lone surrogate on the queue (a "?" box), and an emoji
 * message showed half its length. `clipCharacters` keeps at most 140 code
 * points and never cuts inside a grapheme.
 */
const mockDb = {
  moderation_flags: {
    findMany: jest.fn(),
    count: jest.fn().mockResolvedValue(1),
    groupBy: jest.fn().mockResolvedValue([{ status: "pending", _count: { _all: 1 } }]),
  },
  chat_messages: { count: jest.fn().mockResolvedValue(0) },
  photo_checks: { count: jest.fn().mockResolvedValue(0) },
  user: { findUnique: jest.fn().mockResolvedValue({ role: "app_admin", suspended_at: null, deletedAt: null, password_changed_at: null, sessions_revoked_at: null }) },
}
jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("@/lib/auth", () => ({ getAuth: jest.fn().mockResolvedValue({ user: { id: "admin", role: "app_admin", signedInAt: 0 } }) }))
jest.mock("@/lib/trust", () => ({ trustSignalsFor: jest.fn().mockResolvedValue(new Map()) }))
jest.mock("@/lib/socket-server", () => ({ emitChatMessageHidden: jest.fn() }))

import { getModerationQueue } from "@/app/dashboard/moderation/actions"

const EXCERPT_MAX = 140
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

async function excerptOf(content: string): Promise<string> {
  mockDb.moderation_flags.findMany.mockResolvedValue([
    {
      id: "f1",
      created_at: new Date(),
      source: "auto_keyword",
      confidence: 0.9,
      categories: { contact_info: 0.9 },
      auto_action: "hidden",
      status: "pending",
      user_id: "u1",
      user: { name: "Kavya Nair", email: "k@x", deletedAt: null },
      message: { id: "m1", content, deleted_at: null, chat_group: { event: { id: "e1", title: "Night" } } },
    },
  ])
  const { rows } = await getModerationQueue("pending")
  return rows[0].excerpt
}

describe("getModerationQueue excerpt", () => {
  it("drops a family emoji that straddles the cut whole, leaving no lone surrogate", async () => {
    const excerpt = await excerptOf(`${"a".repeat(EXCERPT_MAX - 1)}👨‍👩‍👧 call me`)
    expect(excerpt).not.toMatch(loneSurrogate)
    expect(excerpt).toBe("a".repeat(EXCERPT_MAX - 1))
  })

  it("counts an emoji as one character, as the composer does", async () => {
    expect(await excerptOf("🎉".repeat(EXCERPT_MAX + 10))).toBe("🎉".repeat(EXCERPT_MAX))
  })

  it("control: plain text is cut at 140 and a short message comes back whole", async () => {
    expect(await excerptOf("a".repeat(EXCERPT_MAX + 60))).toBe("a".repeat(EXCERPT_MAX))
    expect(await excerptOf("call me")).toBe("call me")
  })
})
