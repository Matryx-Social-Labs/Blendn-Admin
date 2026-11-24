/**
 * What a socket may say about typing, before anything is read for it. A typing
 * start costs three to five reads (`emitChatTyping`, `emitPrivateTyping`), and
 * the app sends one per burst of typing.
 *
 * - **A start** is dropped within `TYPING_START_MS` of the last one let through
 *   for that room.
 * - **A stop** passes when it ends a start that was let through. Stops cost the
 *   same reads, so letting every one pass would be the way round the start's
 *   gate; nobody is shown typing without a start, so nothing is lost.
 *
 * Per socket, held weakly: gone with the socket. Per process, as sockets are.
 */
export const TYPING_START_MS = 2_000
/** Rooms remembered per socket, the one typed in longest ago forgotten first. */
export const TYPING_ROOMS_MAX = 50

const rooms = new WeakMap<object, Map<string, { startedAt: number; typing: boolean }>>()

export function mayEmitTyping(socket: object, room: string, isTyping: boolean, now: number = Date.now()): boolean {
  const mine = rooms.get(socket) ?? new Map<string, { startedAt: number; typing: boolean }>()
  rooms.set(socket, mine)
  const last = mine.get(room)
  if (!isTyping) {
    if (!last?.typing) return false
    mine.set(room, { ...last, typing: false })
    return true
  }
  if (last && now - last.startedAt < TYPING_START_MS) return false
  mine.delete(room)
  if (mine.size >= TYPING_ROOMS_MAX) {
    const oldest = mine.keys().next().value
    if (oldest !== undefined) mine.delete(oldest)
  }
  mine.set(room, { startedAt: now, typing: true })
  return true
}
