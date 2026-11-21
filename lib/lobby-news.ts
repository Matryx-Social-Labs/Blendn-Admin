import { Prisma } from "@prisma/client"

import { lobbyState } from "./board"
import { db } from "./db"
import { hiddenAuthorsFor, hidesTickets } from "./lobby"

type NewsEvent = { id: string; start_time: Date; end_time: Date; ticketing_mode: string }

/**
 * Going's "Lobby · N new" (SCRUM-1095, ROADMAP Going 6, owner pick L2): for each event whose Lobby is open, how many
 * live posts by others the caller's Lobby would show after their seen marker (`board_seen`, all of them when there is
 * none). Never the caller's own, never a hidden author's (`hiddenAuthorsFor`), never a spare ticket where the Lobby
 * hides tickets (`livePostsWhere`'s rules). One grouped query for the page: no N+1.
 *
 * Only events in the map get a `lobby` object; read-only (doors open) and closed Lobbies are not news.
 */
export async function lobbyNewCounts(viewerId: string, events: readonly NewsEvent[], now: Date = new Date()): Promise<Map<string, number>> {
  const open = events.filter((e) => lobbyState(e, now) === "open")
  if (open.length === 0) return new Map()
  const hidden = await hiddenAuthorsFor(viewerId)
  const noTickets = open.filter((e) => hidesTickets(e)).map((e) => e.id)
  const rows = await db.$queryRaw<{ event_id: string; n: number }[]>`
    SELECT p.event_id::text AS event_id, count(*)::int AS n
      FROM board_posts p
      LEFT JOIN board_seen s ON s.event_id = p.event_id AND s.user_id = ${viewerId}
     WHERE p.event_id = ANY(${open.map((e) => e.id)}::uuid[])
       AND p.deleted_at IS NULL
       AND p.author_id <> ${viewerId}
       ${hidden.length ? Prisma.sql`AND NOT (p.author_id = ANY(${hidden}::text[]))` : Prisma.empty}
       AND (s.seen_at IS NULL OR p.created_at > s.seen_at)
       AND NOT (p.event_id = ANY(${noTickets}::uuid[]) AND p.sub_kind IS NOT DISTINCT FROM 'ticket')
     GROUP BY p.event_id`
  const counts = new Map(open.map((e) => [e.id, 0]))
  for (const r of rows) counts.set(r.event_id, r.n)
  return counts
}
