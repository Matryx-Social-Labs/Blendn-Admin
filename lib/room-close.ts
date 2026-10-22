// Relative imports: chat-lifecycle.ts reaches this from server.ts (see the note there).
import { db } from "./db"
import { logger } from "./logger"

/**
 * Everybody out of a room whose owner just closed it (step 7, E3): a board
 * post withdrawn, taken down, kept by an erasure, or archived by the sweeper.
 * Its door already refuses them — this stops a socket that joined before. They
 * keep the rest of the app; a rejoin meets the door. Every instance, through
 * the adapter.
 *
 * Its own module, reading the `globalThis` io that lib/socket-server.ts
 * publishes, so a writer like lib/board-access.ts can close a room without
 * importing the whole socket server.
 */
export function closeRoomSockets(chatGroupId: string): void {
  globalThis.__blendnSocketIo?.in(`chat:${chatGroupId}`).socketsLeave(`chat:${chatGroupId}`)
}

/**
 * One person out of a room their door no longer opens for — a crew member who
 * left or was removed. Every socket they hold, on every instance.
 */
export function leaveRoomSockets(chatGroupId: string, userId: string): void {
  globalThis.__blendnSocketIo?.in(`user:${userId}`).socketsLeave(`chat:${chatGroupId}`)
}

/** `closeRoomSockets` for the rooms of these board posts, if they have any. Never rejects: the close has committed. */
export async function closePostRooms(postIds: string[]): Promise<void> {
  if (postIds.length === 0) return
  try {
    const rooms = await db.chat_groups.findMany({ where: { board_post_id: { in: postIds } }, select: { id: true } })
    for (const room of rooms) closeRoomSockets(room.id)
  } catch (error) {
    logger.error("Closing post rooms failed", { error: error instanceof Error ? error.message : String(error) })
  }
}
