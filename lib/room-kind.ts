// Relative imports: chat-lifecycle.ts reaches this from server.ts, which plain
// tsc compiles with the @/ alias left verbatim (see the note there).
import type { chat_group_kind, chat_group_status } from "@prisma/client"
import { db } from "./db"
import {
  chatWindowState,
  eventHidesRoom,
  leftByChoice,
  mayWriteToRoom,
  roomReadDenial,
  type ChatWindowState,
  type ReadDenial,
  type WriteDenial,
} from "./chat-window"
import type { RoomScope } from "./room-handle"

/**
 * The door of a room of any kind (plan v2 §7, F8).
 *
 * A room used to have exactly one event, and every rule about who may enter
 * read that event. Now a room has a `kind` and one owner of that kind
 * (`chat_groups_one_owner`, a CHECK in the migration), and "may this person be
 * in here" is the owner's question:
 *
 *   event       today's rule, unchanged: `roomReadDenial` / `mayWriteToRoom`
 *   board_post  the post's author, or an asker the author accepted — not one
 *               in a block with the author either way (the board reads a block
 *               as a withdrawn post); closed with the post, with a hidden
 *               event, and for writes `OWNER_ROOM_HOURS` after the event ends
 *   crew        a member of the crew now — not suspended, the crew not
 *               dissolved. Real names inside (`namesInRoom`, lib/identity.ts)
 *   blend       a present member of either side — no owner column yet
 *
 * A member row is never enough on its own for a room that is not an event's:
 * it records a pseudonym, a mute, a ban or a leave, and the owner says whether
 * the person still belongs. An unknown kind, or a room whose owner is missing
 * (only possible on a database built without the CHECK), is refused as if the
 * room did not exist.
 *
 * Every door goes through here: the socket join (`canJoinChat`), every
 * delivery into the room (`emitAsSeenBy` re-asks per recipient), the room's
 * HTTP reads and writes, the roster, typing, a message report.
 * `__tests__/chat-join-per-kind.test.ts` pins the switch;
 * `__tests__/chat-group-event-readers.test.ts` keeps every other reader of a
 * room's event to the places that know it is an event room.
 */

/**
 * How long after its event ends a room owned by something AT that event stays
 * open for writes: a board post's now, a Blend's once it has an owner (plan v2
 * §6, "closes 12 h after the event"). The chat sweeper archives it then
 * (`chat-lifecycle`).
 */
export const OWNER_ROOM_HOURS = 12

export function ownerRoomClosesAt(event: { end_time: Date }): Date {
  return new Date(event.end_time.getTime() + OWNER_ROOM_HOURS * 60 * 60 * 1000)
}

/** Everything the board-post door reads, for these viewers. Every viewer-specific row names its viewer. */
function boardPostSelect(viewerIds: string[]) {
  return {
    select: {
      author_id: true,
      deleted_at: true,
      // start_time beside end_time, as every window read selects them (chat-window-select.test.ts).
      event: { select: { status: true, deleted_at: true, start_time: true, end_time: true } },
      requests: { where: { from_user_id: { in: viewerIds }, status: "accepted" as const }, select: { from_user_id: true } },
      // A block either way between the author and a viewer (E4).
      author: {
        select: {
          blocked_users: { where: { blocked_id: { in: viewerIds } }, select: { blocked_id: true } },
          blocked_by: { where: { blocker_id: { in: viewerIds } }, select: { blocker_id: true } },
        },
      },
    },
  }
}

/**
 * The board post behind a room, as its door reads it for one caller. Put it in
 * the room's select. The rows it reads carry the caller's id, and
 * `roomOwnerDenial` checks them against the id it is asked about: a door built
 * for one person never admits another.
 */
export function boardPostDoor(viewerId: string) {
  return boardPostSelect([viewerId])
}

interface BoardPostOwner {
  author_id: string
  deleted_at: Date | null
  event: { status: string; deleted_at: Date | null; end_time: Date }
  /** Accepted asks, by asker (`boardPostDoor`: the caller's only). */
  requests: { from_user_id: string }[]
  author: { blocked_users: { blocked_id: string }[]; blocked_by: { blocker_id: string }[] }
}

/** Everything the crew door reads, for these viewers: their own member rows, if the crew still stands. */
function crewSelect(viewerIds: string[]) {
  return {
    select: {
      dissolved_at: true,
      // The suspended and the erased are on no crew surface (§6 Safety).
      members: {
        where: { user_id: { in: viewerIds }, user: { suspended_at: null, deletedAt: null } },
        select: { user_id: true },
      },
    },
  }
}

/** The crew behind a room, as its door reads it for one caller. */
export function crewDoor(viewerId: string) {
  return crewSelect([viewerId])
}

interface CrewOwner {
  dissolved_at: Date | null
  /** The caller's member row, if they are in the crew (`crewDoor`). */
  members: { user_id: string }[]
}

/**
 * Every owner's door for one caller, to spread into a room's select: whatever
 * the room's kind, the row its door needs is read, and a kind added without
 * one fails closed (`roomOwnerDenial` reads a missing owner as "hidden").
 */
export function ownerDoor(viewerId: string) {
  return { board_post: boardPostDoor(viewerId), crew: crewDoor(viewerId) }
}

interface RoomOwners<E> {
  kind: chat_group_kind
  event: E | null
  board_post: BoardPostOwner | null
  /** Optional so an older select fails closed rather than failing to compile into an open door. */
  crew?: CrewOwner | null
}

function crewDenial(crew: CrewOwner | null | undefined, userId: string): "hidden" | "not_member" | null {
  // A dissolved crew's room is archived and gone for everyone (D-15).
  if (!crew || crew.dissolved_at) return "hidden"
  return crew.members.some((m) => m.user_id === userId) ? null : "not_member"
}

function boardPostDenial(post: BoardPostOwner | null, userId: string): "hidden" | "not_member" | null {
  // A removed post (withdrawn, or taken down by moderation) closes its room,
  // and so does a hidden event, which takes its board with it (SCRUM-8).
  if (!post || post.deleted_at || eventHidesRoom(post.event)) return "hidden"
  const named = [
    ...post.requests.map((r) => r.from_user_id),
    ...post.author.blocked_users.map((b) => b.blocked_id),
    ...post.author.blocked_by.map((b) => b.blocker_id),
  ]
  // Read for somebody else: never let it answer for this caller.
  if (named.some((id) => id !== userId)) return "hidden"
  if (post.author_id === userId) return null
  // The board treats a block as a withdrawn post; the room goes with it, for this pair.
  if (post.author.blocked_users.length > 0 || post.author.blocked_by.length > 0) return "hidden"
  return post.requests.length > 0 ? null : "not_member"
}

/**
 * Whether the room's owner admits this person: the per-kind half of the door,
 * before anything about their member row. `hidden` means the room is not
 * there for them (answer 404); `not_member` that it is, and they are not in
 * it.
 */
export function roomOwnerDenial(
  room: RoomOwners<{ status?: string; deleted_at: Date | null }>,
  userId: string
): "hidden" | "not_member" | null {
  switch (room.kind) {
    case "event":
      return !room.event || eventHidesRoom(room.event) ? "hidden" : null
    case "board_post":
      return boardPostDenial(room.board_post, userId)
    case "crew":
      return crewDenial(room.crew, userId)
    // No owner column yet, and `chat_groups_one_owner` refuses the row.
    case "blend":
      return "hidden"
    default: {
      const unknown: never = room.kind
      void unknown
      return "hidden"
    }
  }
}

/**
 * Why somebody may not read a room — its history, roster, socket. One rule for
 * every kind; an event's room is `roomReadDenial` exactly as it was.
 */
export function roomReadDenialFor<E extends Parameters<typeof roomReadDenial>[1]>(
  room: RoomOwners<E>,
  membership: Parameters<typeof roomReadDenial>[0],
  userId: string
): ReadDenial | null {
  if (room.kind === "event") return room.event ? roomReadDenial(membership, room.event) : "hidden"
  const owner = roomOwnerDenial(room, userId)
  if (owner) return owner
  if (!membership) return "not_member"
  if (membership.status === "banned") return "banned"
  if (leftByChoice(membership)) return "not_member"
  return null
}

/**
 * Why a member may not write. An event's room is `mayWriteToRoom` exactly as
 * it was. Any other room is open until its owner's clock or a lock or archive
 * closes it, and the owner must still admit the writer.
 *
 * `not_member` is the owner's answer — a member row whose owner no longer
 * admits them — and a route answers it as it answers no member row at all.
 */
export function mayWriteToRoomFor<E extends Parameters<typeof mayWriteToRoom>[1]>(
  room: RoomOwners<E> & { status: chat_group_status },
  membership: Parameters<typeof mayWriteToRoom>[0],
  userId: string,
  now: Date = new Date()
): WriteDenial | { reason: "not_member" } | null {
  if (room.kind === "event") return room.event ? mayWriteToRoom(membership, room.event, room, now) : { reason: "hidden" }
  const owner = roomOwnerDenial(room, userId)
  if (owner === "hidden") return { reason: "hidden" }
  if (owner === "not_member") return { reason: "not_member" }
  if (membership.status === "banned") return { reason: "banned" }
  if (membership.status === "muted") return { reason: "muted" }
  const window = roomWindowFor(room, now)
  if (!window.open) return { reason: window.reason }
  if (membership.status === "left") return { reason: "left" }
  return null
}

/**
 * Whether the room takes writes now. An event's room has its calendar window
 * (`chatWindowState`). A board post's closes `OWNER_ROOM_HOURS` after its
 * event ends — on the clock, whether or not the sweeper has archived it yet —
 * and before that when locked or archived. A crew's has no clock: it is open
 * until it is locked or archived (a dissolved crew's is). Blend: no owner yet.
 */
export function roomWindowFor<E extends Parameters<typeof chatWindowState>[0]>(
  room: {
    kind: chat_group_kind
    status: chat_group_status
    event: E | null
    board_post?: { event: { end_time: Date } } | null
  },
  now: Date = new Date()
): ChatWindowState {
  if (room.kind === "event") return room.event ? chatWindowState(room.event, room, now) : { open: false, reason: "hidden" }
  if (room.kind === "crew") return room.status === "active" ? { open: true } : { open: false, reason: room.status }
  if (room.kind !== "board_post" || !room.board_post) return { open: false, reason: "hidden" }
  if (room.status !== "active") return { open: false, reason: room.status }
  if (now >= ownerRoomClosesAt(room.board_post.event)) return { open: false, reason: "window_closed" }
  return { open: true }
}

/**
 * Who the owner of a room that is not an event's admits, out of `candidates`
 * — for a delivery (`emitAsSeenBy` re-asks on every fan-out, so a room its
 * owner closed stops reaching people even before anything evicts them) and for
 * the roster. Null for an event's room: its door is the member row, as before.
 *
 * One read, then `roomOwnerDenial` per person on that person's rows, so this
 * cannot disagree with the door.
 */
export async function ownerAdmits(chatGroupId: string, candidates: string[]): Promise<Set<string> | null> {
  const room = await db.chat_groups.findUnique({
    where: { id: chatGroupId },
    select: { kind: true, board_post: boardPostSelect(candidates), crew: crewSelect(candidates) },
  })
  if (!room) return new Set()
  if (room.kind === "event") return null
  if (room.kind === "crew") return new Set(candidates.filter((id) => crewDenial(room.crew, id) === null))
  const post = room.board_post
  return new Set(
    candidates.filter(
      (id) =>
        roomOwnerDenial(
          {
            kind: room.kind,
            event: null,
            board_post: post && {
              ...post,
              requests: post.requests.filter((r) => r.from_user_id === id),
              author: {
                blocked_users: post.author.blocked_users.filter((b) => b.blocked_id === id),
                blocked_by: post.author.blocked_by.filter((b) => b.blocker_id === id),
              },
            },
          },
          id
        ) === null
    )
  )
}

/**
 * Everybody a room that is not an event's admits, for its roster: a board
 * post's author and the accepted askers, a crew's members. Null for an event's
 * room. Blend: nobody, until it has an owner.
 */
export async function ownerRoster(chatGroupId: string): Promise<Set<string> | null> {
  const room = await db.chat_groups.findUnique({
    where: { id: chatGroupId },
    select: {
      kind: true,
      board_post: { select: { author_id: true, requests: { where: { status: "accepted" }, select: { from_user_id: true } } } },
      crew: { select: { members: { select: { user_id: true } } } },
    },
  })
  if (!room) return new Set()
  if (room.kind === "event") return null
  const candidates = room.board_post
    ? [room.board_post.author_id, ...room.board_post.requests.map((r) => r.from_user_id)]
    : (room.crew?.members.map((m) => m.user_id) ?? [])
  return candidates.length ? ownerAdmits(chatGroupId, candidates) : new Set()
}

/**
 * The scope a room's handles are minted in (`lib/room-handle.ts`): its event
 * for an event's room, so every handle an installed client holds still
 * resolves; its own id and kind for any other. Throws for an event room with
 * no event, which the CHECK forbids — a handle minted from the wrong id would
 * be a different person, so there is no fallback.
 */
export function roomScope(room: { id: string; kind: chat_group_kind; event_id: string | null }): RoomScope {
  if (room.kind !== "event") return { kind: room.kind, groupId: room.id }
  if (!room.event_id) throw new Error(`Event room ${room.id} has no event`)
  return room.event_id
}
