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
const published = { status: "published", deleted_at: null }
const active = { status: "active", left_at: null }

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
  const room = (event: { status: string; deleted_at: Date | null } | null) => ({ kind: "event" as const, event, board_post: null })

  it("admits a member and refuses a stranger, a ban and a hidden event", () => {
    expect(roomReadDenialFor(room(published), active, STRANGER)).toBeNull()
    expect(roomReadDenialFor(room(published), null, STRANGER)).toBe("not_member")
    expect(roomReadDenialFor(room(published), { status: "banned", left_at: null }, STRANGER)).toBe("banned")
    expect(roomReadDenialFor(room({ status: "draft", deleted_at: null }), active, STRANGER)).toBe("hidden")
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
    expect(mayWriteToRoomFor(boardRoom(), { status: "active" }, ASKER, BEFORE_CLOSE)).toEqual({ reason: "not_member" })
  })

  it("refuses a stranger with no row", () => {
    expect(roomReadDenialFor(boardRoom({ viewer: STRANGER }), null, STRANGER)).toBe("not_member")
  })

  it("closes with its post and with its event", () => {
    expect(roomReadDenialFor(boardRoom({ viewer: AUTHOR, deleted: true }), active, AUTHOR)).toBe("hidden")
    expect(roomReadDenialFor(boardRoom({ viewer: AUTHOR, eventStatus: "draft" }), active, AUTHOR)).toBe("hidden")
  })

  it("still honours the member row: a ban, and leaving by choice", () => {
    expect(roomReadDenialFor(boardRoom({ accepted: true }), { status: "banned", left_at: null }, ASKER)).toBe("banned")
    expect(roomReadDenialFor(boardRoom({ accepted: true }), { status: "left", left_at: new Date() }, ASKER)).toBe("not_member")
  })

  it("takes writes until it is locked or archived, and never from the muted", () => {
    const author = { viewer: AUTHOR }
    expect(mayWriteToRoomFor(boardRoom(author), { status: "active" }, AUTHOR, BEFORE_CLOSE)).toBeNull()
    expect(mayWriteToRoomFor(boardRoom({ ...author, status: "locked" }), { status: "active" }, AUTHOR, BEFORE_CLOSE)).toEqual({ reason: "locked" })
    expect(mayWriteToRoomFor(boardRoom({ ...author, status: "archived" }), { status: "active" }, AUTHOR, BEFORE_CLOSE)).toEqual({ reason: "archived" })
    expect(mayWriteToRoomFor(boardRoom(author), { status: "muted" }, AUTHOR, BEFORE_CLOSE)).toEqual({ reason: "muted" })
    expect(mayWriteToRoomFor(boardRoom({ ...author, deleted: true }), { status: "active" }, AUTHOR, BEFORE_CLOSE)).toEqual({ reason: "hidden" })
  })

  it("closes twelve hours after its event ends, on the clock, whether or not the sweeper has run (E2)", () => {
    const closes = ownerRoomClosesAt({ end_time: END })
    expect(closes.toISOString()).toBe("2026-10-03T06:00:00.000Z")
    const room = boardRoom({ viewer: AUTHOR })
    expect(roomWindowFor(room, new Date(closes.getTime() - 1))).toEqual({ open: true })
    expect(roomWindowFor(room, closes)).toEqual({ open: false, reason: "window_closed" })
    expect(mayWriteToRoomFor(room, { status: "active" }, AUTHOR, closes)).toEqual({ reason: "window_closed" })
  })

  it("closes for an asker in a block with the author, either way — the board reads a block as a withdrawn post (E4)", () => {
    expect(roomReadDenialFor(boardRoom({ accepted: true, authorBlocked: true }), active, ASKER)).toBe("hidden")
    expect(roomReadDenialFor(boardRoom({ accepted: true, blockedAuthor: true }), active, ASKER)).toBe("hidden")
    expect(mayWriteToRoomFor(boardRoom({ accepted: true, blockedAuthor: true }), { status: "active" }, ASKER, BEFORE_CLOSE)).toEqual({
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

describe("crew and Blend rooms have no owner yet, so nobody is in one", () => {
  it.each(["crew", "blend"] as const)("a %s room refuses even an active member row", (kind) => {
    const room = { kind, status: "active" as const, event: null, board_post: null }
    expect(roomReadDenialFor(room, active, AUTHOR)).toBe("hidden")
    expect(mayWriteToRoomFor(room, { status: "active" }, AUTHOR)).toEqual({ reason: "hidden" })
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
