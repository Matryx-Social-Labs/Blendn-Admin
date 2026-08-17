const mockDb = {
  chat_group_members: { count: jest.fn() },
  push_tokens: { groupBy: jest.fn() },
}

jest.mock("@/lib/db", () => ({ db: mockDb }))

import { roomAudience } from "@/lib/room-audience"

const ROOM = "11111111-1111-4111-8111-111111111111"

/**
 * The audience numbers, which two screens got wrong in opposite ways.
 *
 * `member_status` is `active | muted | banned | left`, and `left` exists
 * because the row is KEPT when somebody leaves — `anonymous_name` lives on it,
 * and deleting it would strip the pseudonyms off every historical message.
 *
 * So "everyone who is not banned" counts people who left, and an organiser's
 * blast-radius number grew all night as the room emptied.
 */

beforeEach(() => {
  jest.clearAllMocks()
  mockDb.chat_group_members.count.mockResolvedValue(0)
  mockDb.push_tokens.groupBy.mockResolvedValue([])
})

describe("members counts who is actually in the room", () => {
  it("asks for active and muted, never for not-banned", async () => {
    await roomAudience(ROOM)

    const where = mockDb.chat_group_members.count.mock.calls[0][0].where
    expect(where.status).toEqual({ in: ["active", "muted"] })
    // The bug in its exact previous shape.
    expect(where.status).not.toHaveProperty("not")
  })

  it("includes muted members, who are still in the room and still reading", async () => {
    const where = (await (async () => {
      await roomAudience(ROOM)
      return mockDb.chat_group_members.count.mock.calls[0][0].where
    })())
    expect(where.status.in).toContain("muted")
  })

  it("excludes members who left", async () => {
    await roomAudience(ROOM)
    const where = mockDb.chat_group_members.count.mock.calls[0][0].where
    expect(where.status.in).not.toContain("left")
    expect(where.status.in).not.toContain("banned")
  })
})

describe("reachable counts people, not devices", () => {
  it("groups by user_id in the database rather than materialising rows", async () => {
    /*
     * One person with a phone and a tablet is one recipient. The previous
     * version fetched every push_token row into Node to call `.length` on the
     * array — one row over the wire per token, to produce one integer.
     */
    mockDb.push_tokens.groupBy.mockResolvedValue([{ user_id: "a" }, { user_id: "b" }])

    const audience = await roomAudience(ROOM)

    expect(audience.reachable).toBe(2)
    expect(mockDb.push_tokens.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ by: ["user_id"] })
    )
  })

  it("scopes tokens to members of THIS room, in the same states", async () => {
    await roomAudience(ROOM)

    const arg = mockDb.push_tokens.groupBy.mock.calls[0][0]
    const membership = arg.where.user.chat_group_memberships.some
    expect(membership.chat_group_id).toBe(ROOM)
    // Someone who left the room must not still be counted as reachable.
    expect(membership.status).toEqual({ in: ["active", "muted"] })
  })
})

describe("connected is lazy, and absent is not zero", () => {
  it("is not requested unless asked for", async () => {
    const audience = await roomAudience(ROOM)
    // A socket round-trip on every dashboard page load would be waste.
    expect(audience).not.toHaveProperty("connected")
  })

  it("is undefined rather than 0 when the adapter cannot answer", async () => {
    /*
     * The distinction that matters. A room with nobody in it and a room we
     * cannot ask are different facts; rendering the second as the first is how
     * a working event looks dead to the organiser watching it.
     *
     * In this environment `lib/socket-server` has no booted `io`, which is
     * exactly the "cannot answer" case.
     */
    const audience = await roomAudience(ROOM, { connected: true })
    expect(audience.connected).toBeUndefined()
    expect(audience.connected).not.toBe(0)
  })
})
