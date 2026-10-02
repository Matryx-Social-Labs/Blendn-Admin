jest.mock("@/lib/db", () => ({ db: {} }))
import { readFileSync } from "fs"
import { join } from "path"
import { mayWriteToRoomFor, ownerRoomClosesAt, roomOwnerDenial, roomReadDenialFor, roomScope, roomWindowFor } from "@/lib/room-kind"

/**
 * The door of a room of every kind (CR-G01, F8, plan v2 §7).
 *
 * A room has a kind and one owner, and whether somebody may be in it is the
 * owner's question. The failure this pins is the cheap one: deciding that a
 * crew, Blend or board-post room is "anyone with a `chat_group_members` row",
 * which turns a stale row (an ask the author never accepted, a member who left
 * the crew) into a key. And its twin: a missing owner answered with a stand-in
 * event that lets everybody through.
 */

const ROOT = join(__dirname, "..")
const read = (f: string) => readFileSync(join(ROOT, f), "utf8")

const AUTHOR = "u_author"
const ASKER = "u_asker"
const STRANGER = "u_stranger"
const published = { status: "published", deleted_at: null, kind: "event" as const }
const active = { status: "active", left_at: null, last_allowed_at: null }

const END = new Date("2026-10-02T18:00:00Z")

/**
 * A board post's room as `boardPostDoor(viewer)` reads it: the viewer's
 * accepted ask, and a block either way between the author and the viewer,
 * each row naming the viewer it was read for.
 */
function boardRoom(
  over: {
    viewer?: string
    accepted?: boolean
    deleted?: boolean
    eventStatus?: string
    status?: "active" | "locked" | "archived"
    authorBlocked?: boolean
    blockedAuthor?: boolean
  } = {}
) {
  const viewer = over.viewer ?? ASKER
  return {
    kind: "board_post" as const,
    status: over.status ?? ("active" as const),
    event: null,
    board_post: {
      author_id: AUTHOR,
      deleted_at: over.deleted ? new Date() : null,
      event: { status: over.eventStatus ?? "published", deleted_at: null, end_time: END },
      requests: over.accepted ? [{ from_user_id: viewer }] : [],
      author: {
        blocked_users: over.authorBlocked ? [{ blocked_id: viewer }] : [],
        blocked_by: over.blockedAuthor ? [{ blocker_id: viewer }] : [],
      },
    },
  }
}
const BEFORE_CLOSE = new Date(END.getTime() + 60 * 60 * 1000)

describe("an event's room is today's rule, unchanged", () => {
  const room = (event: { status: string; deleted_at: Date | null; kind: "event" } | null) => ({ kind: "event" as const, event, board_post: null })

  it("admits a member and refuses a stranger, a ban and a hidden event", () => {
    expect(roomReadDenialFor(room(published), active, STRANGER)).toBeNull()
    expect(roomReadDenialFor(room(published), null, STRANGER)).toBe("not_member")
    expect(roomReadDenialFor(room(published), { status: "banned", left_at: null, last_allowed_at: null }, STRANGER)).toBe("banned")
    expect(roomReadDenialFor(room({ status: "draft", deleted_at: null, kind: "event" }), active, STRANGER)).toBe("hidden")
  })

  it("refuses an event room whose event is missing, rather than inventing one", () => {
    // Only a database built without `chat_groups_one_owner` can hold this row.
    expect(roomReadDenialFor(room(null), active, STRANGER)).toBe("hidden")
    expect(roomOwnerDenial(room(null), STRANGER)).toBe("hidden")
  })
})

describe("a board post's room: the author, or an asker the author accepted", () => {
  it("admits the author and an accepted asker", () => {
    expect(roomReadDenialFor(boardRoom({ viewer: AUTHOR }), active, AUTHOR)).toBeNull()
    expect(roomReadDenialFor(boardRoom({ accepted: true }), active, ASKER)).toBeNull()
  })

  it("refuses somebody with a member row and no accepted ask — the row is not the key", () => {
    expect(roomReadDenialFor(boardRoom(), active, ASKER)).toBe("not_member")
    expect(mayWriteToRoomFor(boardRoom(), { status: "active", last_allowed_at: null }, ASKER, BEFORE_CLOSE)).toEqual({ reason: "not_member" })
  })

  it("refuses a stranger with no row", () => {
    expect(roomReadDenialFor(boardRoom({ viewer: STRANGER }), null, STRANGER)).toBe("not_member")
  })

  it("closes with its post and with its event", () => {
    expect(roomReadDenialFor(boardRoom({ viewer: AUTHOR, deleted: true }), active, AUTHOR)).toBe("hidden")
    expect(roomReadDenialFor(boardRoom({ viewer: AUTHOR, eventStatus: "draft" }), active, AUTHOR)).toBe("hidden")
  })

  it("still honours the member row: a ban, and leaving by choice", () => {
    expect(roomReadDenialFor(boardRoom({ accepted: true }), { status: "banned", left_at: null, last_allowed_at: null }, ASKER)).toBe("banned")
    expect(roomReadDenialFor(boardRoom({ accepted: true }), { status: "left", left_at: new Date(), last_allowed_at: null }, ASKER)).toBe("not_member")
  })

  it("takes writes until it is locked or archived, and never from the muted", () => {
    const author = { viewer: AUTHOR }
    expect(mayWriteToRoomFor(boardRoom(author), { status: "active", last_allowed_at: null }, AUTHOR, BEFORE_CLOSE)).toBeNull()
    expect(mayWriteToRoomFor(boardRoom({ ...author, status: "locked" }), { status: "active", last_allowed_at: null }, AUTHOR, BEFORE_CLOSE)).toEqual({ reason: "locked" })
    expect(mayWriteToRoomFor(boardRoom({ ...author, status: "archived" }), { status: "active", last_allowed_at: null }, AUTHOR, BEFORE_CLOSE)).toEqual({ reason: "archived" })
    expect(mayWriteToRoomFor(boardRoom(author), { status: "muted", last_allowed_at: null }, AUTHOR, BEFORE_CLOSE)).toEqual({ reason: "muted" })
    expect(mayWriteToRoomFor(boardRoom({ ...author, deleted: true }), { status: "active", last_allowed_at: null }, AUTHOR, BEFORE_CLOSE)).toEqual({ reason: "hidden" })
  })

  it("closes twelve hours after its event ends, on the clock, whether or not the sweeper has run (E2)", () => {
    const closes = ownerRoomClosesAt({ end_time: END })
    expect(closes.toISOString()).toBe("2026-10-03T06:00:00.000Z")
    const room = boardRoom({ viewer: AUTHOR })
    expect(roomWindowFor(room, new Date(closes.getTime() - 1))).toEqual({ open: true })
    expect(roomWindowFor(room, closes)).toEqual({ open: false, reason: "window_closed" })
    expect(mayWriteToRoomFor(room, { status: "active", last_allowed_at: null }, AUTHOR, closes)).toEqual({ reason: "window_closed" })
  })

  it("closes for an asker in a block with the author, either way — the board reads a block as a withdrawn post (E4)", () => {
    expect(roomReadDenialFor(boardRoom({ accepted: true, authorBlocked: true }), active, ASKER)).toBe("hidden")
    expect(roomReadDenialFor(boardRoom({ accepted: true, blockedAuthor: true }), active, ASKER)).toBe("hidden")
    expect(mayWriteToRoomFor(boardRoom({ accepted: true, blockedAuthor: true }), { status: "active", last_allowed_at: null }, ASKER, BEFORE_CLOSE)).toEqual({
      reason: "hidden",
    })
  })

  it("never answers for somebody other than the viewer it was read for (no double-id mismatch)", () => {
    // Read for the accepted asker, asked about a stranger: refused, not admitted on their row.
    expect(roomOwnerDenial(boardRoom({ viewer: ASKER, accepted: true }), STRANGER)).toBe("hidden")
    // Read for a blocked viewer, asked about the author: refused rather than trusted.
    expect(roomOwnerDenial(boardRoom({ viewer: STRANGER, authorBlocked: true }), AUTHOR)).toBe("hidden")
  })
})

/** A crew's room as `crewDoor(viewer)` reads it: the viewer's own member row, if they are in the crew. */
function crewRoom(over: { viewer?: string; member?: boolean; dissolved?: boolean; status?: "active" | "locked" | "archived" } = {}) {
  const viewer = over.viewer ?? ASKER
  return {
    kind: "crew" as const,
    status: over.status ?? ("active" as const),
    event: null,
    board_post: null,
    crew: { dissolved_at: over.dissolved ? new Date() : null, members: over.member ? [{ user_id: viewer }] : [] },
  }
}

describe("a crew's room: its members now, and nobody else", () => {
  it("admits a member of the crew", () => {
    expect(roomReadDenialFor(crewRoom({ member: true }), active, ASKER)).toBeNull()
    expect(mayWriteToRoomFor(crewRoom({ member: true }), { status: "active", last_allowed_at: null }, ASKER)).toBeNull()
  })

  it("refuses somebody with a member row who is no longer in the crew — the row is not the key", () => {
    // Left or removed: the room row stays (`left`), the crew row is gone.
    expect(roomReadDenialFor(crewRoom(), active, ASKER)).toBe("not_member")
    expect(mayWriteToRoomFor(crewRoom(), { status: "active", last_allowed_at: null }, ASKER)).toEqual({ reason: "not_member" })
  })

  it("refuses a stranger with no row", () => {
    expect(roomReadDenialFor(crewRoom({ viewer: STRANGER }), null, STRANGER)).toBe("not_member")
  })

  it("is gone for everyone once the crew dissolves (D-15)", () => {
    expect(roomReadDenialFor(crewRoom({ member: true, dissolved: true }), active, ASKER)).toBe("hidden")
  })

  it("still honours the member row: a ban, and leaving by choice", () => {
    expect(roomReadDenialFor(crewRoom({ member: true }), { status: "banned", left_at: null, last_allowed_at: null }, ASKER)).toBe("banned")
    expect(roomReadDenialFor(crewRoom({ member: true }), { status: "left", left_at: new Date(), last_allowed_at: null }, ASKER)).toBe("not_member")
  })

  it("has no clock: open while active, closed when locked or archived", () => {
    expect(roomWindowFor(crewRoom({ member: true }), new Date("2030-01-01"))).toEqual({ open: true })
    expect(roomWindowFor(crewRoom({ member: true, status: "archived" }))).toEqual({ open: false, reason: "archived" })
    expect(mayWriteToRoomFor(crewRoom({ member: true, status: "locked" }), { status: "active", last_allowed_at: null }, ASKER)).toEqual({ reason: "locked" })
  })

  it("never answers for somebody other than the viewer it was read for", () => {
    expect(roomOwnerDenial(crewRoom({ viewer: ASKER, member: true }), STRANGER)).toBe("not_member")
  })

  it("fails closed on a select that never read the crew", () => {
    const { crew, ...unread } = crewRoom({ member: true })
    void crew
    expect(roomOwnerDenial(unread, ASKER)).toBe("hidden")
  })
})

const SOON = new Date(Date.now() + 6 * 60 * 60 * 1000)
const A1 = "u_a1"
const A2 = "u_a2"
const B1 = "u_b1"
const SOLO = "u_solo"
type Blocks = { blocked_users: { blocked_id: string }[]; blocked_by: { blocker_id: string }[] }
const none: Blocks = { blocked_users: [], blocked_by: [] }

/**
 * A Blend's room as `blendDoor(viewer)` reads it: the viewer's own side rows,
 * members of either side in a block with the viewer, the viewer's check-in at
 * the occurrence, and the solo's blocks with the viewer.
 */
function blendRoom(
  viewer: string,
  over: {
    sideA?: string[]
    sideB?: string[]
    solo?: string | null
    here?: boolean
    closesAt?: Date
    closed?: boolean
    blockedBy?: { id: string; side: "a" | "b" | "solo" }
    status?: "active" | "archived" | "locked"
  } = {}
) {
  const member = (id: string, side: "a" | "b") => ({
    user_id: id,
    user: over.blockedBy?.id === id && over.blockedBy.side === side ? { blocked_users: [{ blocked_id: viewer }], blocked_by: [] } : none,
  })
  const sideRows = (ids: string[], side: "a" | "b") =>
    ids.filter((id) => id === viewer || over.blockedBy?.id === id).map((id) => member(id, side))
  const solo = over.solo === undefined ? null : over.solo
  return {
    kind: "blend" as const,
    status: over.status ?? ("active" as const),
    event: null,
    board_post: null,
    blend: {
      closes_at: over.closesAt ?? SOON,
      closed_at: over.closed ? new Date() : null,
      b_user_id: solo,
      occurrence: { check_ins: over.here === false ? [] : [{ user_id: viewer }] },
      a_crew: { dissolved_at: null, members: sideRows(over.sideA ?? [A1, A2], "a") },
      b_crew: solo ? null : { dissolved_at: null, members: sideRows(over.sideB ?? [B1], "b") },
      b_user: solo
        ? {
            suspended_at: null,
            deletedAt: null,
            ...(over.blockedBy?.side === "solo" ? { blocked_users: [{ blocked_id: viewer }], blocked_by: [] } : none),
          }
        : null,
    },
  }
}

describe("a Blend's room: the people of either side who are here, until it closes (CR-K03, CR-K04, D-9)", () => {
  it("admits a member of either crew who is at the occurrence, and the matched person", () => {
    expect(roomReadDenialFor(blendRoom(A1), active, A1)).toBeNull()
    expect(roomReadDenialFor(blendRoom(B1), active, B1)).toBeNull()
    expect(roomReadDenialFor(blendRoom(SOLO, { solo: SOLO }), active, SOLO)).toBeNull()
  })

  it("refuses a member of a side who is not at the occurrence (CR-K03)", () => {
    expect(roomReadDenialFor(blendRoom(A2, { here: false }), active, A2)).toBe("not_member")
  })

  it("refuses somebody on neither side, whatever row they hold", () => {
    expect(roomReadDenialFor(blendRoom(STRANGER), active, STRANGER)).toBe("not_member")
  })

  it("is gone for everyone once it closes: on its clock (CR-K04), or early", () => {
    expect(roomReadDenialFor(blendRoom(A1, { closesAt: new Date(Date.now() - 1) }), active, A1)).toBe("hidden")
    expect(roomReadDenialFor(blendRoom(A1, { closed: true }), active, A1)).toBe("hidden")
    expect(roomWindowFor({ kind: "blend", status: "active", event: null, blend: { closes_at: new Date(Date.now() - 1), closed_at: null } })).toEqual({
      open: false,
      reason: "window_closed",
    })
    expect(roomWindowFor({ kind: "blend", status: "active", event: null, blend: { closes_at: SOON, closed_at: null } })).toEqual({ open: true })
  })

  it("refuses somebody in a block with anyone on the other side, either way", () => {
    expect(roomReadDenialFor(blendRoom(A1, { blockedBy: { id: B1, side: "b" } }), active, A1)).toBe("hidden")
    expect(roomReadDenialFor(blendRoom(B1, { blockedBy: { id: A2, side: "a" } }), active, B1)).toBe("hidden")
    expect(roomReadDenialFor(blendRoom(A1, { solo: SOLO, blockedBy: { id: SOLO, side: "solo" } }), active, A1)).toBe("hidden")
    // A block inside one's own side is not across the sides.
    expect(roomReadDenialFor(blendRoom(A1, { blockedBy: { id: A2, side: "a" } }), active, A1)).toBeNull()
  })

  it("still honours the member row: leaving alone (CR-I14) and a ban", () => {
    expect(roomReadDenialFor(blendRoom(A1), { status: "left", left_at: new Date(), last_allowed_at: null }, A1)).toBe("not_member")
    expect(roomReadDenialFor(blendRoom(A1), { status: "banned", left_at: null, last_allowed_at: null }, A1)).toBe("banned")
  })

  it("never answers for somebody other than the viewer it was read for", () => {
    expect(roomOwnerDenial(blendRoom(A1), A2)).toBe("not_member")
  })

  it("an unknown kind is refused", () => {
    const room = { kind: "guild" as never, status: "active" as const, event: published, board_post: null }
    expect(roomOwnerDenial(room, AUTHOR)).toBe("hidden")
    expect(roomReadDenialFor(room, active, AUTHOR)).toBe("hidden")
  })
})

describe("handles are scoped per room", () => {
  it("an event room keeps its event as the scope; any other room is its own id and kind", () => {
    expect(roomScope({ id: "g1", kind: "event", event_id: "e1" })).toBe("e1")
    expect(roomScope({ id: "g1", kind: "board_post", event_id: null })).toEqual({ kind: "board_post", groupId: "g1" })
    expect(() => roomScope({ id: "g1", kind: "event", event_id: null })).toThrow()
  })
})

describe("every door goes through the one rule (structural)", () => {
  it("the socket join asks roomReadDenialFor, and roomOwnerDenial switches on every kind", () => {
    const auth = read("lib/socket-auth.ts")
    const canJoinChat = auth.slice(auth.indexOf("export async function canJoinChat"), auth.indexOf("export async function canJoinConversation"))
    expect(canJoinChat).toMatch(/roomReadDenialFor\(/)
    expect(canJoinChat).not.toMatch(/\broomReadDenial\(/)
    expect(read("lib/socket-server.ts")).toMatch(/"join:chat"[\s\S]{0,200}canJoinChat\(/)

    const kind = read("lib/room-kind.ts")
    const owner = kind.slice(kind.indexOf("export function roomOwnerDenial"), kind.indexOf("export function roomReadDenialFor"))
    for (const k of ["event", "board_post", "crew", "blend"]) expect(owner).toContain(`case "${k}":`)
    // The arm TypeScript fails on when a kind is added without a door.
    expect(owner).toMatch(/const \w+: never = room\.kind/)
  })

  it("every room select reads every owner's door (`ownerDoor`), never one owner by hand", () => {
    // A select that names `board_post: boardPostDoor(…)` alone reads no crew,
    // so a crew room's door would answer "hidden" there — or, worse, a door
    // added later would be read by half the routes.
    const files = [
      "lib/socket-auth.ts",
      "lib/socket-server.ts",
      "lib/room-delivery.ts",
      "lib/room-membership.ts",
      "app/api/mobile/messages/[messageId]/report/route.ts",
      "app/api/mobile/chat/groups/[chatGroupId]/participants/route.ts",
      "app/api/mobile/chat/groups/[chatGroupId]/messages/[messageId]/reactions/route.ts",
      "app/api/mobile/chat/groups/[chatGroupId]/messages/route.ts",
    ]
    for (const file of files) {
      const src = read(file)
      expect({ file, byHand: /\b(?:boardPostDoor|crewDoor|blendDoor)\(/.test(src) }).toEqual({ file, byHand: false })
      expect({ file, ownerDoor: /\.\.\.ownerDoor\(/.test(src) }).toEqual({ file, ownerDoor: true })
    }
    const kind = read("lib/room-kind.ts")
    const door = kind.slice(kind.indexOf("export function ownerDoor"), kind.indexOf("interface RoomOwners"))
    expect(door).toMatch(/board_post: boardPostDoor\(viewerId\)/)
    expect(door).toMatch(/crew: crewDoor\(viewerId\)/)
    expect(door).toMatch(/blend: blendDoor\(viewerId\)/)
  })

  it("no route that takes a room by id reads it by the event-only rules", () => {
    const routes = [
      "app/api/mobile/chat/groups/[chatGroupId]/messages/route.ts",
      "app/api/mobile/chat/groups/[chatGroupId]/messages/[messageId]/reactions/route.ts",
      "app/api/mobile/chat/groups/[chatGroupId]/participants/route.ts",
      "app/api/mobile/messages/[messageId]/report/route.ts",
      "lib/room-membership.ts",
    ]
    for (const file of routes) {
      const src = read(file)
      expect({ file, eventOnly: /\b(?:roomReadDenial|mayWriteToRoom|chatWindowState)\(/.test(src) }).toEqual({ file, eventOnly: false })
      expect({ file, kindAware: /\b(?:roomReadDenialFor|mayWriteToRoomFor|roomOwnerDenial)\(/.test(src) }).toEqual({ file, kindAware: true })
    }
  })
})
