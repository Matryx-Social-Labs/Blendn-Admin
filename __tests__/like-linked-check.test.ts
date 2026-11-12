/*
 * A like that was returned and one that was not do the same work (third review
 * M1). The linked check — under the pair's lock — runs BEFORE the reciprocal-like
 * lookup, so how long a like takes says nothing about whether the other person
 * liked back. Pinned by the order and the count of the queries, not by timing.
 */
jest.mock("jose", () => ({ jwtVerify: jest.fn(), createRemoteJWKSet: jest.fn() }))

const log: string[] = []
const record = <T,>(name: string, result: T): jest.Mock => jest.fn(async () => (log.push(name), result))

const mockDb: Record<string, unknown> & { $transaction: jest.Mock; event_likes: Record<string, jest.Mock>; event_waves: Record<string, jest.Mock>; friendships: Record<string, jest.Mock>; private_conversations: Record<string, jest.Mock>; friend_requests: Record<string, jest.Mock> } = {
  event_likes: { upsert: record("event_likes.upsert", {}), findUnique: record<unknown>("event_likes.findUnique", null) },
  // A wave back answers a like as a like does (SCRUM-1042): looked up beside it, always.
  event_waves: { findUnique: record<unknown>("event_waves.findUnique", null) },
  friendships: { findUnique: record<unknown>("friendships.findUnique", null) },
  ended_friendships: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
  private_conversations: { findUnique: record<unknown>("private_conversations.findUnique", null) },
  friend_requests: { findFirst: record<unknown>("friend_requests.findFirst", null) },
  chat_group_members: { findMany: record("chat_group_members.findMany", []) },
  event_match_preferences: { findMany: record("event_match_preferences.findMany", []) },
  $executeRaw: record("lock", 0),
  $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(mockDb)),
}
jest.mock("@/lib/db", () => ({ db: mockDb }))
jest.mock("@/lib/push-notifications", () => ({ notifyMatch: jest.fn(async () => true) }))
jest.mock("@/lib/conversations", () => ({
  ...jest.requireActual("@/lib/conversations"),
  openConversation: jest.fn(async () => ({ id: "conv" })),
}))

import { likeAtEvent } from "@/lib/matches"

const sequence = async (setup: () => void) => {
  jest.clearAllMocks()
  log.length = 0
  mockDb.event_likes.findUnique.mockImplementation(async () => (log.push("event_likes.findUnique"), null))
  mockDb.event_waves.findUnique.mockImplementation(async () => (log.push("event_waves.findUnique"), null))
  mockDb.friendships.findUnique.mockImplementation(async () => (log.push("friendships.findUnique"), null))
  mockDb.private_conversations.findUnique.mockImplementation(async () => (log.push("private_conversations.findUnique"), null))
  mockDb.friend_requests.findFirst.mockImplementation(async () => (log.push("friend_requests.findFirst"), null))
  setup()
  await likeAtEvent("e", "ana", "ben")
  return [...log]
}

const BACK = () => mockDb.event_likes.findUnique.mockImplementation(async () => (log.push("event_likes.findUnique"), { id: "x" }))
const WAVED_BACK = () => mockDb.event_waves.findUnique.mockImplementation(async () => (log.push("event_waves.findUnique"), { id: "w" }))
const LINKED = () => mockDb.friendships.findUnique.mockImplementation(async () => (log.push("friendships.findUnique"), { id: "f" }))

describe("likeAtEvent does the same work whether or not the other person liked back", () => {
  it("takes the lock and asks the three linked questions, then looks for the like back", async () => {
    const notReturned = await sequence(() => undefined)
    const linkedAndReturned = await sequence(() => {
      BACK()
      LINKED()
    })
    const upToTheLookup = (s: string[]) => s.slice(0, s.indexOf("event_likes.findUnique") + 1)

    expect(upToTheLookup(notReturned)).toEqual(upToTheLookup(linkedAndReturned))
    const before = upToTheLookup(notReturned)
    expect(before[0]).toBe("event_likes.upsert")
    expect(before.slice(1, 2)).toEqual(["lock"])
    expect(before.slice(2, 5).sort()).toEqual(["friend_requests.findFirst", "friendships.findUnique", "private_conversations.findUnique"])
    expect(before[before.length - 1]).toBe("event_likes.findUnique")
    // And the whole of it is the same for a like nobody returned and a returned one with a link: nothing more happens.
    expect(notReturned).toEqual(linkedAndReturned)
  })

  it("still opens the conversation for a returned like between people with no link", async () => {
    const open = await sequence(() => BACK())
    expect(open).toContain("chat_group_members.findMany")
    expect(open.indexOf("event_likes.findUnique")).toBeGreaterThan(open.indexOf("friend_requests.findFirst"))
  })
})

describe("a wave back is a like back (SCRUM-1042: an old like is a hidden wave)", () => {
  it("opens the conversation for a like answered by their earlier wave, with the same work as a like back", async () => {
    const byLike = await sequence(() => BACK())
    const byWave = await sequence(() => WAVED_BACK())
    expect(byWave).toContain("chat_group_members.findMany")
    expect(byWave).toEqual(byLike)
  })

  it("control: neither back, nothing opens", async () => {
    expect(await sequence(() => undefined)).not.toContain("chat_group_members.findMany")
  })
})
