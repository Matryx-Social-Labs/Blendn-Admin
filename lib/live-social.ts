// Relative imports: the ops loop in lib/socket-server.ts reaches this from server.ts.
import { connectionCounts, MIN_ATTENDEES, openedInRoom, type ConnectionCounts } from "./connection-metrics"
import { hereNowAt, presentMembersAt } from "./crews/here"
import { crewPeak, mixesMade, type CrewPeak } from "./crews/night"
import { db } from "./db"
import { discloseAnswered, discloseCrews, discloseGroup, disclosePeak, fewCount } from "./disclosure"
import type { LiveCrews, LiveSocial } from "./live-metrics"
import { lensForEvent } from "./tonight"

/** The raw counts behind `LiveSocial`. Never leaves the server as is. */
export interface LiveSocialCounts {
  connections: ConnectionCounts
  conversations: number
  lobby: { offer: number; seeking: number; chat: number }
  tonight: { asked: boolean; answered: number }
  crews: { here: number; people: number; guests: number; peak: CrewPeak | null; mixes: number } | null
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
    occurrenceId ? crewsTonight(occurrenceId) : Promise.resolve(null),
  ])
  return {
    connections,
    conversations: n(rest?.conversations),
    lobby: { offer: n(rest?.offer), seeking: n(rest?.seeking), chat: n(rest?.chat) },
    tonight: { asked: Boolean(lens?.question), answered: n(rest?.answered) },
    crews,
  }
}

/** Today's crews (S8). A crew is here when two or more of its members are (lib/crews/presence.ts); a person counts once. */
async function crewsTonight(occurrenceId: string): Promise<NonNullable<LiveSocialCounts["crews"]>> {
  const now = new Date()
  const [members, guests, recorded, mixes] = await Promise.all([
    presentMembersAt(occurrenceId),
    db.event_check_ins.count({ where: hereNowAt(occurrenceId, now) }),
    crewPeak({ occurrenceId }),
    mixesMade({ occurrenceId }),
  ])
  const present = Array.from(members.values()).filter((m) => m.length >= 2)
  const here = present.length
  const people = new Set(present.flat()).size
  return { here, people, guests, peak: recorded, mixes }
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
    crews: c.crews ? discloseLiveCrews(c.crews) : null,
  }
}

function discloseLiveCrews(c: NonNullable<LiveSocialCounts["crews"]>): LiveCrews {
  const people = discloseAnswered(c.people, c.guests)
  return {
    here: discloseCrews(c.here, c.people).crews,
    people,
    guests: c.guests,
    pct: typeof people === "number" && c.guests > 0 ? Math.round((people / c.guests) * 100) : null,
    peak: disclosePeak(c.peak),
    mixes: fewCount(c.mixes),
  }
}
