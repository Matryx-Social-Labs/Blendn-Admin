import { db } from "@/lib/db"

/**
 * How many people a room reaches, answered honestly.
 *
 * Three numbers, three different questions, and the whole reason this module
 * exists is that two screens were answering them with one number each and
 * getting both wrong.
 *
 * ```
 *   members    chat_group_members WHERE status = 'active'
 *              who is in the room right now
 *
 *   reachable  distinct owners of a push token among those members
 *              who would get a phone notification
 *
 *   connected  sockets currently in the room
 *              who is looking at it this second
 * ```
 *
 * ## What was wrong
 *
 * `app/api/events/[id]/announcements/route.ts` counted members with
 * `status: { not: "banned" }`. `member_status` is `active | muted | banned |
 * left`, and the `left` value exists precisely because the row is KEPT when
 * somebody leaves — `anonymous_name` lives on it, and deleting it would strip
 * the pseudonyms off every historical message. So the "blast radius" shown to
 * an organiser counted everyone who had ever joined, and grew all night as
 * people left.
 *
 * The same route computed `reachable` by fetching every matching `push_tokens`
 * row into Node and taking `.length` — one row per token over the wire to
 * produce one integer.
 *
 * ## Why `connected` is lazy
 *
 * It requires a socket round-trip (`io.in(room).fetchSockets()`), which is
 * cheap once and wasteful on every dashboard page load. Callers ask for it only
 * where a live number is actually rendered.
 *
 * When the adapter is unavailable it comes back `undefined`, never `0`. A room
 * with nobody in it and a room we cannot ask are different facts, and rendering
 * the second as the first is how a working event looks dead.
 */
export interface RoomAudience {
  members: number
  reachable: number
  /** Absent unless requested; `undefined` also means "could not ask". */
  connected?: number
}

export async function roomAudience(
  chatGroupId: string,
  opts: { connected?: boolean } = {}
): Promise<RoomAudience> {
  const [members, reachableRows] = await Promise.all([
    db.chat_group_members.count({
      // `active` only. Not `not: banned` — that counts `left` and `muted`.
      // A muted member is still in the room and still reads it, so they are
      // deliberately included; someone who left is not.
      where: { chat_group_id: chatGroupId, status: { in: ["active", "muted"] } },
    }),
    /*
     * Counted in the database, not in Node.
     *
     * `groupBy` on `user_id` returns one row per distinct person rather than
     * one per token — the distinction that matters, since one person with a
     * phone and a tablet is one recipient. The previous version materialised
     * every token row to call `.length` on the array.
     */
    db.push_tokens.groupBy({
      by: ["user_id"],
      where: {
        user: {
          chat_group_memberships: {
            some: {
              chat_group_id: chatGroupId,
              status: { in: ["active", "muted"] },
            },
          },
        },
      },
    }),
  ])

  const audience: RoomAudience = { members, reachable: reachableRows.length }

  if (opts.connected) {
    audience.connected = await connectedCount(chatGroupId)
  }

  return audience
}

/**
 * Sockets in the room, or `undefined` if the adapter cannot answer.
 *
 * Imported lazily: `lib/socket-server.ts` reaches the HTTP server and is not
 * something a dashboard page should drag in to count members.
 */
async function connectedCount(chatGroupId: string): Promise<number | undefined> {
  try {
    const { socketsInChatRoom } = await import("@/lib/socket-server")
    return await socketsInChatRoom(chatGroupId)
  } catch {
    // A missing adapter, a socket server that has not booted, a dashboard
    // render outside the server process. All of them mean "unknown", and
    // `undefined` is how the UI is told to hide the tile rather than show a
    // zero.
    return undefined
  }
}
