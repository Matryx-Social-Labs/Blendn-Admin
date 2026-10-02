import type { chat_group_kind, chat_group_status } from "@prisma/client"
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
 *   board_post  the post's author, or an asker the author accepted
 *   crew        a member of the crew            — step 8; no owner column yet
 *   blend       a present member of either side — step 8; no owner column yet
 *
 * A member row is never enough on its own for a room that is not an event's:
 * it records a pseudonym, a mute, a ban or a leave, and the owner says whether
 * the person still belongs. An unknown kind, or a room whose owner is missing
 * (only possible on a database built without the CHECK), is refused as if the
 * room did not exist.
 *
 * Every door goes through here: the socket join (`canJoinChat`), the room's
 * HTTP reads and writes, typing. `__tests__/chat-join-per-kind.test.ts` pins
 * the switch; `__tests__/chat-group-event-readers.test.ts` keeps every other
 * reader of a room's event to the places that know it is an event room.
 */

/** The board post behind a room, as its door reads it for one caller. Put it in the room's select. */
export function boardPostDoor(userId: string) {
  return {
    select: {
      author_id: true,
      deleted_at: true,
      event: { select: { status: true, deleted_at: true } },
      requests: { where: { from_user_id: userId, status: "accepted" as const }, select: { id: true }, take: 1 },
    },
  }
}

interface BoardPostOwner {
  author_id: string
  deleted_at: Date | null
  event: { status: string; deleted_at: Date | null }
  /** The caller's accepted ask on this post, if any (`boardPostDoor`). */
  requests: { id: string }[]
}

interface RoomOwners<E> {
  kind: chat_group_kind
  event: E | null
  board_post: BoardPostOwner | null
}

/**
 * Whether the room's owner admits this person: the per-kind half of the door,
 * before anything about their member row. `hidden` means the room is not
 * there for anybody (answer 404); `not_member` that it is, and they are not in
 * it.
 */
export function roomOwnerDenial(
  room: RoomOwners<{ status?: string; deleted_at: Date | null }>,
  userId: string
): "hidden" | "not_member" | null {
  switch (room.kind) {
    case "event":
      return !room.event || eventHidesRoom(room.event) ? "hidden" : null
    case "board_post": {
      const post = room.board_post
      // A removed post (withdrawn, or taken down by moderation) closes its room,
      // and so does a hidden event, which takes its board with it (SCRUM-8).
      if (!post || post.deleted_at || eventHidesRoom(post.event)) return "hidden"
      return post.author_id === userId || post.requests.length > 0 ? null : "not_member"
    }
    // No owner column until step 8, and `chat_groups_one_owner` refuses the row.
    case "crew":
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
 * it was. Any other room has no calendar window: it is open until its owner
 * locks or archives it, and the owner must still admit the writer.
 *
 * `not_member` is the owner's answer — a member row whose owner no longer
 * admits them — and a route answers it as it answers no member row at all.
 */
export function mayWriteToRoomFor<E extends Parameters<typeof mayWriteToRoom>[1]>(
  room: RoomOwners<E> & { status: chat_group_status },
  membership: Parameters<typeof mayWriteToRoom>[0],
  userId: string
): WriteDenial | { reason: "not_member" } | null {
  if (room.kind === "event") return room.event ? mayWriteToRoom(membership, room.event, room) : { reason: "hidden" }
  const owner = roomOwnerDenial(room, userId)
  if (owner === "hidden") return { reason: "hidden" }
  if (owner === "not_member") return { reason: "not_member" }
  if (membership.status === "banned") return { reason: "banned" }
  if (membership.status === "muted") return { reason: "muted" }
  const window = roomWindowFor(room)
  if (!window.open) return { reason: window.reason }
  if (membership.status === "left") return { reason: "left" }
  return null
}

/**
 * Whether the room takes writes now. An event's room has its calendar window
 * (`chatWindowState`); a room of any other kind has none, and is open until
 * it is locked or archived.
 */
export function roomWindowFor<E extends Parameters<typeof chatWindowState>[0]>(room: {
  kind: chat_group_kind
  status: chat_group_status
  event: E | null
}): ChatWindowState {
  if (room.kind === "event") return room.event ? chatWindowState(room.event, room) : { open: false, reason: "hidden" }
  return room.status === "active" ? { open: true } : { open: false, reason: room.status }
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
