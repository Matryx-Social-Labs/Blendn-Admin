jest.mock("@/lib/db", () => ({ db: {} }))
jest.mock("@/lib/push-notifications", () => ({ sendPushNotification: jest.fn() }))

import { isRevealedMatch } from "@/lib/friends"

/** The conversation half of `revealedMatch`: open, match-born, both revealed. */
const row = (over: Partial<Parameters<typeof isRevealedMatch>[0]> = {}) => ({
  user1_pseudonym: "Otter" as string | null,
  user2_pseudonym: "Heron" as string | null,
  user1_revealed: true,
  user2_revealed: true,
  origin_board_request_id: null as string | null,
  closed_at: null as Date | null,
  ...over,
})

describe("isRevealedMatch", () => {
  it("is true for an open match both sides revealed in", () => {
    expect(isRevealedMatch(row())).toBe(true)
  })

  it.each([
    ["only the first side revealed", { user2_revealed: false }],
    ["only the second side revealed", { user1_revealed: false }],
    ["neither side revealed", { user1_revealed: false, user2_revealed: false }],
    ["the conversation is closed", { closed_at: new Date() }],
    ["it is a message request (no pseudonyms)", { user1_pseudonym: null, user2_pseudonym: null }],
    ["it is a board conversation, not a like", { origin_board_request_id: "7d4f1f0e-0000-4000-8000-000000000000" }],
  ])("is false when %s", (_name, over) => {
    expect(isRevealedMatch(row(over))).toBe(false)
  })
})
