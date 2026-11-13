// Relative imports: the ops loop in lib/socket-server.ts reaches this from server.ts.
import { connectionCounts, MIN_ATTENDEES, openedInRoom, type ConnectionCounts } from "./connection-metrics"
import { presentMembersAt } from "./crews/here"
import { db } from "./db"
import { discloseAnswered, discloseCrews, discloseGroup, fewCount } from "./disclosure"
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
      SELECT (SELECT count(*) FROM private_conversations c WHERE ${openedInRoom(eventId)}) AS conversations,
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

/**
 * The counts as a host is shown them. Pairs keep the Overview's rule (nothing
 * under `MIN_ATTENDEES` guests). Every grouped figure (the pairs by way, the
 * Lobby by kind) goes through `discloseGroup`, so a total never sits exact
 * beside a part it hides. Tonight's answers are held from the other side too,
 * "nearly all", when the guests who did not answer are a few.
 */
export function discloseSocial(c: LiveSocialCounts): LiveSocial {
  const { attendees, connected, byWay } = c.connections
  const ways = discloseGroup([byWay.waves, byWay.lobby, byWay.requests])
  const posts = discloseGroup([c.lobby.offer, c.lobby.seeking, c.lobby.chat])
  return {
    attendees,
    met:
      attendees < MIN_ATTENDEES
        ? { held: true, floor: MIN_ATTENDEES }
        : {
            held: false,
            pct: Math.round((connected / attendees) * 100),
            connected,
            connections: ways.total,
            byWay: { waves: ways.parts[0], lobby: ways.parts[1], requests: ways.parts[2] },
          },
    conversations: fewCount(c.conversations),
    lobby: { posts: posts.total, offer: posts.parts[0], seeking: posts.parts[1], chat: posts.parts[2] },
    tonight: c.tonight.asked ? { answered: discloseAnswered(c.tonight.answered, attendees) } : null,
    crews: c.crews ? crewsHere(discloseCrews(c.crews.here, c.crews.people)) : null,
  }
}

const crewsHere = ({ crews, people }: { crews: FewCount; people: FewCount }) => ({ here: crews, people })
