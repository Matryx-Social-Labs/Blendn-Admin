import { db } from "@/lib/db"
import { openRoomHandle } from "@/lib/room-handle"
import { roomReadDenialFor, withOwnerDoor } from "@/lib/room-kind"

/**
 * A message request sent by a Lobby (board post) room's handle (Flow 5 C5, "Met in the Lobby · Your ride").
 *
 * Such a handle names somebody only inside its room (`lib/room-handle.ts`); this is the one place outside it that
 * takes one back, and only while the post's door seats BOTH the sender and the person named — the author or an
 * accepted asker, a member of the room not banned or gone, the post standing, the room not over
 * (`roomReadDenialFor`, the room's own read rule). The two have been talking in that room, so it stands in for the
 * shared check-in a request otherwise needs (a ride is arranged before the night).
 *
 * `null` when the ref is not a Lobby room's handle at all (the caller goes on as before); `{ refused: true }` when it
 * is one and the room does not seat them both (the caller answers as for nobody).
 */
export async function lobbyMeeting(
  ref: string,
  senderId: string,
  now: Date = new Date()
): Promise<{ roomId: string; recipientId: string } | { refused: true } | null> {
  const opened = openRoomHandle(ref)
  if (!opened || typeof opened.scope === "string" || opened.scope.kind !== "board_post") return null
  const roomId = opened.scope.groupId
  const seated = await Promise.all([senderId, opened.userId].map((userId) => seatedIn(roomId, userId, now)))
  return seated.every(Boolean) ? { roomId, recipientId: opened.userId } : { refused: true }
}

async function seatedIn(roomId: string, userId: string, now: Date): Promise<boolean> {
  const room = await db.chat_groups.findUnique({
    where: { id: roomId },
    select: { kind: true, status: true, members: { where: { user_id: userId }, select: { status: true, left_at: true, last_allowed_at: true } } },
  })
  if (!room || room.kind !== "board_post" || room.status === "archived") return false
  const door = await withOwnerDoor(roomId, userId, { kind: room.kind, event: null })
  return roomReadDenialFor(door, room.members[0] ?? null, userId, now) === null
}
