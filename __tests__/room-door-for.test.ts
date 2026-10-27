const findUnique = jest.fn()
jest.mock("@/lib/db", () => ({ db: { chat_groups: { findUnique: (...a: unknown[]) => findUnique(...a) } } }))

import { ownerDoorFor, roomOwnerDenial, withOwnerDoor } from "@/lib/room-kind"

/**
 * One room's lookup reads the door of its own kind and no other (perf/chat-path:
 * all three kinds' doors on every lookup made an event room 34 statements). The
 * half that matters is the other side of that: a room whose door was NOT read
 * is never admitted for want of it.
 */
beforeEach(() => findUnique.mockReset())

const NON_EVENT = ["board_post", "crew", "blend"] as const
const eventRow = { status: "published", deleted_at: null }

describe("ownerDoorFor selects only the room's own kind", () => {
  it("selects nothing for an event's room and exactly one owner for any other", () => {
    expect(ownerDoorFor("event", "u1")).toEqual({})
    for (const kind of NON_EVENT) expect(Object.keys(ownerDoorFor(kind, "u1"))).toEqual([kind])
  })
})

describe("withOwnerDoor", () => {
  it("costs an event's room no read at all", async () => {
    const room = { kind: "event" as const, event: eventRow }
    await expect(withOwnerDoor("g1", "u1", room)).resolves.toBe(room)
    expect(findUnique).not.toHaveBeenCalled()
  })

  it("passes a missing room through untouched", async () => {
    await expect(withOwnerDoor("g1", "u1", null)).resolves.toBeNull()
    expect(findUnique).not.toHaveBeenCalled()
  })

  it.each(NON_EVENT)("reads one owner's rows for a %s room, for the caller", async (kind) => {
    findUnique.mockResolvedValue({})
    await withOwnerDoor("g1", "u1", { kind, event: null })
    expect(findUnique).toHaveBeenCalledTimes(1)
    expect(findUnique.mock.calls[0][0].where).toEqual({ id: "g1" })
    expect(Object.keys(findUnique.mock.calls[0][0].select)).toEqual([kind])
  })

  it("does not mutate the room it was given", async () => {
    findUnique.mockResolvedValue({ crew: { dissolved_at: null, members: [{ user_id: "u1" }] } })
    const room = { kind: "crew" as const, event: null }
    const withDoor = await withOwnerDoor("g1", "u1", room)
    expect(room).toEqual({ kind: "crew", event: null })
    expect(withDoor.crew).toEqual({ dissolved_at: null, members: [{ user_id: "u1" }] })
  })
})

describe("fails closed: a door that was not read admits nobody", () => {
  it.each(NON_EVENT)("a %s room with no door read is hidden", (kind) => {
    expect(roomOwnerDenial({ kind, event: null }, "u1")).toBe("hidden")
  })

  it.each(NON_EVENT)("a %s room that vanishes between the two reads is hidden", async (kind) => {
    findUnique.mockResolvedValue(null)
    const room = await withOwnerDoor("g1", "u1", { kind, event: null })
    expect(roomOwnerDenial(room, "u1")).toBe("hidden")
  })
})

describe("the door for each kind still refuses a non-member", () => {
  const read = async (kind: (typeof NON_EVENT)[number], door: unknown, viewer = "u1") => {
    findUnique.mockResolvedValue(door)
    return roomOwnerDenial(await withOwnerDoor("g1", viewer, { kind, event: null }), viewer)
  }

  it("crew: not in the crew is not_member; in it is admitted; dissolved is hidden", async () => {
    expect(await read("crew", { crew: { dissolved_at: null, members: [] } })).toBe("not_member")
    expect(await read("crew", { crew: { dissolved_at: null, members: [{ user_id: "u1" }] } })).toBeNull()
    expect(await read("crew", { crew: { dissolved_at: new Date(), members: [{ user_id: "u1" }] } })).toBe("hidden")
  })

  it("board_post: a stranger is not_member; the author is admitted", async () => {
    const post = (author_id: string) => ({
      board_post: {
        author_id,
        deleted_at: null,
        event: { status: "published", deleted_at: null, end_time: new Date(Date.now() + 3_600_000) },
        requests: [],
        author: { blocked_users: [], blocked_by: [] },
      },
    })
    expect(await read("board_post", post("someone-else"))).toBe("not_member")
    expect(await read("board_post", post("u1"))).toBeNull()
  })

  it("blend: nobody on either side is not_member", async () => {
    const side = { dissolved_at: null, hidden_at: null, members: [] }
    const blend = {
      closes_at: new Date(Date.now() + 3_600_000),
      closed_at: null,
      b_user_id: null,
      occurrence: { check_ins: [{ user_id: "u1" }] },
      a_crew: side,
      b_crew: side,
      b_user: null,
    }
    expect(await read("blend", { blend })).toBe("not_member")
  })
})
