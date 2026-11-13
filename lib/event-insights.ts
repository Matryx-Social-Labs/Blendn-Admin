// Relative imports, like the rest of lib/.
import { MIN_ATTENDEES, type ConnectionCounts } from "./connection-metrics"
import { db } from "./db"
import { discloseAnswered, discloseCrews, discloseFigure, discloseGroup, fewCount, heldPart, type FewCount, type HeldTotal } from "./disclosure"
import { insightCountsOf, type InsightCounts } from "./insight-tallies"
import { lensForEvent } from "./tonight"

/*
 * What an organiser is shown of a night once it has run (Post A, SCRUM-1051,
 * mockup post-A-did-people-meet.png): the "Did people meet" funnel and the
 * Lobby, Tonight's question and crews beside it. Read from the frozen tally
 * once there is one, so a night reads the same after the purges, and from the
 * rows until then. Every floor is applied here, on the server: the page gets
 * the disclosed figures and nothing else.
 */

/** A figure a tally frozen before it was counted does not have. Never shown as 0. */
export type NotRecorded = "not_recorded"

/**
 * `InsightCounts` as a tally holds it. Tallies frozen before 2026-11-13 lack
 * the pairs by way, and those before Post A lack kept talking, conversations
 * and crews.
 */
export type StoredInsightCounts = Omit<InsightCounts, "connections" | "conversations" | "crews"> & {
  connections: Omit<ConnectionCounts, "byWay" | "keptTalking"> & Partial<Pick<ConnectionCounts, "byWay" | "keptTalking">>
  conversations?: number
  crews?: InsightCounts["crews"]
}

/** A funnel stage: how many, and the share of who came. */
export interface Stage {
  count: number
  pct: number
}

export interface EventInsights {
  /** Guests who checked in: the funnel's first stage and every share's denominator. */
  attendees: number
  funnel:
    | { held: true; floor: number }
    | {
        held: false
        /** Made a first move here. Null: held (`heldPart` against who came). */
        reachedOut: Stage | null
        /** In at least one connection. */
        met: Stage
        /** In a connection whose chat has a message from each side. Null: held (`heldPart` against who met). */
        keptTalking: Stage | null | NotRecorded
        /** Pairs, once each; a floor when a way is a few (`discloseGroup`). */
        connections: number | HeldTotal
        /** Connections per person (2 × pairs ÷ who came); null when the total is a floor, since it would give it back. */
        perAttendee: number | null
        /** Null: not recorded (a tally frozen before the split). */
        byWay: { waves: FewCount; lobby: FewCount; requests: FewCount } | null
      }
  conversations: FewCount | NotRecorded
  lobby: { posts: number | HeldTotal; offer: FewCount; seeking: FewCount; chat: FewCount; asks: FewCount; accepted: number | null }
  /** Null: the room asked no question and nobody answered one. */
  tonight: {
    answered: FewCount | "nearly_all"
    /** Share of who came, when `answered` is a number. */
    pct: number | null
    /** "Here to" on a work-lens night; null when nobody said. */
    workIntent: { total: number | HeldTotal; parts: { hire: FewCount; find_work: FewCount; build: FewCount; learn: FewCount } } | null
  } | null
  crews: { came: FewCount; people: FewCount } | NotRecorded
}

const pct = (part: number, whole: number) => Math.round((part / whole) * 100)
const stage = (count: number | null, attendees: number): Stage | null => (count === null ? null : { count, pct: pct(count, attendees) })

/** The counts as an organiser is shown them. Pure, so every floor is brute-forced (`event-insights.test.ts`). */
export function discloseInsights(c: StoredInsightCounts, asked: boolean): EventInsights {
  const { attendees, connections, connected, reachedOut, byWay, keptTalking } = c.connections
  const ways = byWay ? discloseGroup([byWay.waves, byWay.lobby, byWay.requests]) : null
  const total = ways ? ways.total : connections
  const posts = discloseGroup([c.lobby.offer, c.lobby.seeking, c.lobby.chat])
  const { hire, find_work, build, learn } = c.tonight.workIntent
  const intents = hire + find_work + build + learn > 0 ? discloseGroup([hire, find_work, build, learn]) : null
  const answered = discloseAnswered(c.tonight.answered, attendees)
  const crews = c.crews ? discloseCrews(c.crews.came, c.crews.people) : null
  // The pairs floor, through the one suppression rule. Every attendee is a possible member of a pair, so only its
  // minimum cell can fire (contributors = population would trip the dominance rule on every night).
  const pairsHeld = discloseFigure({ count: attendees, contributors: attendees, population: attendees, floor: MIN_ATTENDEES }).reason === "min_cell"

  return {
    attendees,
    funnel:
      pairsHeld
        ? { held: true, floor: MIN_ATTENDEES }
        : {
            held: false,
            reachedOut: stage(heldPart(reachedOut, attendees), attendees),
            met: { count: connected, pct: pct(connected, attendees) },
            // Against who met, not who came: "20 met, 17 kept talking" names the 3 who stopped.
            keptTalking: keptTalking === undefined ? "not_recorded" : stage(heldPart(keptTalking, connected), attendees),
            connections: total,
            // Each pair is a connection for both people (F2), one decimal; never beside a floor, which it would undo.
            perAttendee: typeof total === "number" ? Math.round(((2 * total) / attendees) * 10) / 10 : null,
            byWay: ways && { waves: ways.parts[0], lobby: ways.parts[1], requests: ways.parts[2] },
          },
    conversations: c.conversations === undefined ? "not_recorded" : fewCount(c.conversations),
    lobby: {
      posts: posts.total,
      offer: posts.parts[0],
      seeking: posts.parts[1],
      chat: posts.parts[2],
      asks: fewCount(c.lobby.asks),
      accepted: heldPart(c.lobby.accepted, c.lobby.asks),
    },
    tonight:
      asked || c.tonight.answered > 0
        ? {
            answered,
            pct: typeof answered === "number" && attendees > 0 ? pct(answered, attendees) : null,
            workIntent: intents && {
              total: intents.total,
              parts: { hire: intents.parts[0], find_work: intents.parts[1], build: intents.parts[2], learn: intents.parts[3] },
            },
          }
        : null,
    crews: crews ? { came: crews.crews, people: crews.people } : "not_recorded",
  }
}

/**
 * A night's insights for its organiser: the frozen tally once there is one, the
 * rows until then. `pinnedSince`: when the host's own Lobby note went up.
 */
export async function eventInsights(eventId: string): Promise<EventInsights & { pinnedSince: string | null }> {
  const [frozen, lens, pinned] = await Promise.all([
    db.event_insight_tallies.findUnique({ where: { event_id: eventId }, select: { counts: true } }),
    lensForEvent(eventId),
    db.board_host_posts.findUnique({ where: { event_id: eventId }, select: { created_at: true } }),
  ])
  const counts = frozen ? (frozen.counts as unknown as StoredInsightCounts) : await insightCountsOf(eventId)
  return { ...discloseInsights(counts, Boolean(lens?.question)), pinnedSince: pinned?.created_at.toISOString() ?? null }
}
