// Relative imports: the ops loop in lib/socket-server.ts reaches this from server.ts.
import { connectionCounts, MIN_ATTENDEES, type ConnectionCounts } from "./connection-metrics"
import { presentMembersAt } from "./crews/here"
import { db } from "./db"
import { MIN_CELL } from "./disclosure"
import type { FewCount, LiveSocial } from "./live-metrics"
import { lensForEvent } from "./tonight"

/** The raw counts behind `LiveSocial`. Never leaves the server as is. */
export interface LiveSocialCounts {
  connections: ConnectionCounts
  conversations: number
  lobby: { offer: number; seeking: number; chat: number }
  tonight: { asked: boolean; answered: number }
  crews: { here: number; people: number } | null
}

const n = (v: bigint | number | null | undefined) => Number(v ?? 0)

/**
 * How the room is meeting, counted (Live A). One parallel wave, run once a
 * minute by the ops loop (`HELD_SOCIAL_MS`), never on its five-second tick.
 */
export async function liveSocialCounts(eventId: string, occurrenceId: string | null): Promise<LiveSocialCounts> {
  const [connections, [rest], lens, crews] = await Promise.all([
    connectionCounts(eventId),
    // board-visibility: counts only, live posts, as `insightCountsOf` counts them.
    db.$queryRaw<{ conversations: bigint; offer: bigint; seeking: bigint; chat: bigint; answered: bigint }[]>`
      SELECT (SELECT count(*) FROM private_conversations c
               WHERE c.origin_event_id = ${eventId}::uuid
                  OR c.origin_board_request_id IN (SELECT id FROM board_requests WHERE event_id = ${eventId}::uuid)) AS conversations,
             (SELECT count(*) FROM board_posts WHERE event_id = ${eventId}::uuid AND deleted_at IS NULL AND kind = 'offer') AS offer,
             (SELECT count(*) FROM board_posts WHERE event_id = ${eventId}::uuid AND deleted_at IS NULL AND kind = 'seeking') AS seeking,
             (SELECT count(*) FROM board_posts WHERE event_id = ${eventId}::uuid AND deleted_at IS NULL AND kind = 'chat') AS chat,
             (SELECT count(*) FROM event_match_preferences WHERE event_id = ${eventId}::uuid AND tonight_answer IS NOT NULL) AS answered`,
    lensForEvent(eventId),
    occurrenceId ? presentMembersAt(occurrenceId) : Promise.resolve(null),
  ])
  // A crew is here when two or more of its members are (lib/crews/presence.ts).
  const present = crews ? Array.from(crews.values()).filter((members) => members.length >= 2) : null
  return {
    connections,
    conversations: n(rest?.conversations),
    lobby: { offer: n(rest?.offer), seeking: n(rest?.seeking), chat: n(rest?.chat) },
    tonight: { asked: Boolean(lens?.question), answered: n(rest?.answered) },
    crews: present ? { here: present.length, people: present.reduce((sum, m) => sum + m.length, 0) } : null,
  }
}

const few = (count: number): FewCount => (count > 0 && count < MIN_CELL ? "few" : count)

/**
 * The counts as a host is shown them. Pairs keep the Overview's rule (exact
 * from `MIN_ATTENDEES` guests, nothing under it). Every count of people is a
 * few under `MIN_CELL`; Tonight's answers are also held from the other side,
 * "nearly all", when the guests who did not answer are a few.
 *
 * ponytail: a way-of-meeting cell under five is "a few" while the pair total
 * stays exact, so two hidden cells' sum can be subtracted. Pairs, never who;
 * hold the total too if a split cell ever carries people rather than pairs.
 */
export function discloseSocial(c: LiveSocialCounts): LiveSocial {
  const { attendees, connections, connected, byWay } = c.connections
  const answered = Math.min(c.tonight.answered, attendees)
  const posts = c.lobby.offer + c.lobby.seeking + c.lobby.chat
  return {
    attendees,
    met:
      attendees < MIN_ATTENDEES
        ? { held: true, floor: MIN_ATTENDEES }
        : {
            held: false,
            pct: Math.round((connected / attendees) * 100),
            connected,
            connections,
            byWay: { waves: few(byWay.waves), lobby: few(byWay.lobby), requests: few(byWay.requests) },
          },
    conversations: few(c.conversations),
    lobby: { posts: few(posts), offer: few(c.lobby.offer), seeking: few(c.lobby.seeking), chat: few(c.lobby.chat) },
    tonight: c.tonight.asked
      ? { answered: answered >= MIN_CELL && attendees - answered > 0 && attendees - answered < MIN_CELL ? "nearly_all" : few(answered) }
      : null,
    crews: c.crews ? { here: c.crews.here, people: few(c.crews.people) } : null,
  }
}
