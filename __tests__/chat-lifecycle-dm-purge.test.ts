/*
 * The DM purge (SCRUM-1237) is one step of the chat-lifecycle pass, with its
 * own catch: the pass calls it, and its failure is logged and never skips the
 * steps after it (the Tonight answers and the waves). Everything else is a fake.
 */
const mockPurgeDms = jest.fn()
const mockTonight = jest.fn().mockResolvedValue({ answers: 0, hasMore: false })
const mockGestures = jest.fn().mockResolvedValue({ waves: 0, likes: 0, hasMore: false })

jest.mock("@/lib/db", () => ({ db: { chat_groups: { findMany: () => Promise.reject(new Error("not this test")) } } }))
jest.mock("@/lib/heartbeat", () => ({ beat: jest.fn() }))
jest.mock("@/lib/room-close", () => ({ closeRoomSockets: jest.fn() }))
jest.mock("@/lib/crews/sweep", () => ({ repairCrews: async () => ({ repaired: 0 }), purgeLapsedCrewLikes: async () => 0, purgeLapsedCrewLinks: async () => 0 }))
jest.mock("@/lib/lobby-photo", () => ({ recheckPendingPhotos: async () => 0 }))
jest.mock("@/lib/dm-retention", () => ({ purgeClosedConversations: (...a: unknown[]) => mockPurgeDms(...a) }))
jest.mock("@/lib/lobby-retention", () => ({
  purgeClosedLobbies: async () => ({ messages: 0, posts: 0, photos: 0, hostPosts: 0, alertPreferences: 0, seenMarkers: 0, feedback: 0, pseudonyms: 0, excerpts: 0, kept: 0, hasMore: false }),
  purgeTonightAnswers: (...a: unknown[]) => mockTonight(...a),
  purgeEventGestures: (...a: unknown[]) => mockGestures(...a),
}))

import { startChatLifecycleSweeper, stopChatLifecycleSweeper } from "@/lib/chat-lifecycle"
import { logger } from "@/lib/logger"

it("runs the DM purge in the pass, logs its failure, and still runs the steps after it", async () => {
  mockPurgeDms.mockRejectedValue(new Error("db blip"))
  const errors = jest.spyOn(logger, "error").mockImplementation(() => {})
  jest.spyOn(logger, "info").mockImplementation(() => {})

  startChatLifecycleSweeper()
  for (let i = 0; i < 100 && mockGestures.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 10))
  stopChatLifecycleSweeper()

  expect(mockPurgeDms).toHaveBeenCalledTimes(1)
  expect(errors).toHaveBeenCalledWith("DM purge failed", { error: "db blip" })
  expect(mockTonight).toHaveBeenCalled()
  expect(mockGestures).toHaveBeenCalled()
})
