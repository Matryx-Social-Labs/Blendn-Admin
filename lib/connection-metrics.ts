// Relative, not "@/lib/*": the purge freezes these counts (lib/insight-tallies.ts), and the
// lifecycle sweeper that runs it is reachable from server.ts (server-import-boundary.test.ts).
import { Prisma } from "@prisma/client"

import { db } from "./db"

/**
 * Did anyone actually meet anyone?
 *
 * Attendance says people came. Sentiment says how it felt. Neither says whether
 * the thing the product exists for happened, and for a networking event that is
 * the outcome — an organiser filling a room where nobody connects has run a
 * successful party and a failed networking event.
 *
 * The industry has settled on **connections per attendee** as the number: two
 * connections at a 200-person event means the format failed, twelve means it
 * worked, and an event where more than half of attendees make at least one is
 * performing well. Both are reported here, because the mean alone hides the
 * shape — ten people making twelve connections each and everyone else making
 * none averages well and is a bad event.
 *
 * ## A connection is mutual
 *
 * Both people said yes: they waved at each other, or one accepted the other's
 * Lobby ask or message request. One-sided waves and likes are not counted and
 * are never exposed. A wave nobody returned is private to the person who sent
 * it, and an organiser learning how many unreciprocated waves their event
 * produced would be learning something about individuals dressed up as a
 * statistic.
 *
 * ## Suppressed for small rooms
 *
 * Below `MIN_ATTENDEES` these figures identify people. "One connection among
 * three attendees" names both of them to anyone who was there. Aggregates stop
 * being aggregates at small n, and an organiser's curiosity is not worth that.
 */

/**
 * The floor, **declared** rather than hand-rolled. See ER5.
 *
 * Higher than `MIN_CELL` on purpose, and the reason is specific to this figure:
 * it is about *pairs*, and a pair is more identifying than an individual. At
 * eight attendees, "3 connections" is 28 possible pairs and tells you nothing
 * about which; at five it is 10, and a room that small remembers who was
 * talking to whom.
 *
 * Declared once, here, and read by both readers of these counts (the Overview's
 * `discloseInsights`, the Live tab's `discloseSocial`) rather than each keeping
 * its own: two floors that were never reconciled is how this file began.
 */
export const MIN_ATTENDEES = 8

/** The raw counts, before any floor: `discloseInsights` (lib/event-insights.ts) and `discloseSocial` apply them. Never leaves the server as is. */
export interface ConnectionCounts {
  attendees: number
  connections: number
  connected: number
  reachedOut: number
  /**
   * The connections by the first way each pair met (mutual waves, which take
   * in an old like answered; an accepted Lobby ask; an accepted request from
   * this room), so the three add up to `connections`. Absent from tallies
   * frozen before 2026-11-13.
   */
  byWay: ConnectionWays
  /**
   * People in a connection whose chat, opened from this room (`origin_event_id`
   * or one of its Lobby asks), has a message from each side: the funnel stage
   * taps cannot inflate (Post A). Absent from tallies frozen before Post A.
   */
  keptTalking: number
}

export interface ConnectionWays {
  waves: number
  lobby: number
  requests: number
}

/** A chat (`private_conversations c`) opened from this room: a wave or request here, or one of its Lobby asks. */
export const openedInRoom = (eventId: string) => Prisma.sql`(c.origin_event_id = ${eventId}::uuid
  OR c.origin_board_request_id IN (SELECT id FROM board_requests WHERE event_id = ${eventId}::uuid))`

export async function connectionCounts(eventId: string): Promise<ConnectionCounts> {
  /*
   * One statement over the union of pairs (approval 1, 2026-11-12). A pair of
   * attendees is connected when, at this event, they:
   *
   *   1. each waved at or liked the other -- an old like is a hidden wave
   *      (approval 11), exactly the mutual `openIfMutual` opens a match for, so
   *      an event from before the Wave build still counts its mutual likes;
   *   2. had a Lobby ask accepted, either way round;
   *   3. accepted a message request sent from this room (`met_in_event_id`).
   *
   * `DISTINCT ON` the ordered pair (lo, hi) is what counts a pair once however
   * many ways they met, under the first of them (the "how they met" split). Only pairs of two attendees count, so the share who
   * met someone is a share of the people who came.
   *
   * In SQL, not memory: recorded waves at a concert are attendance squared
   * (G3). Nothing but the three counts leaves the database.
   */
  // board-visibility: accepted asks only, and a silenced ask is stored `declined`; a count, to nobody's side.
  const [row] = await db.$queryRaw<
    { attendees: number; connections: number; connected: number; reached_out: number; waves: number; lobby: number; requests: number; kept_talking: number }[]
  >`
    WITH att AS (
      SELECT DISTINCT user_id FROM event_check_ins
       WHERE event_id = ${eventId}::uuid AND check_in_time IS NOT NULL AND kind = 'attendee'
    ),
    gestures AS (
      SELECT a, b, min(at) AS at FROM (
        SELECT liker_id AS a, liked_id AS b, created_at AS at FROM event_likes WHERE event_id = ${eventId}::uuid
        UNION ALL
        SELECT from_id, to_id, created_at FROM event_waves WHERE event_id = ${eventId}::uuid
      ) g GROUP BY a, b
    ),
    -- Each way a pair met, and when: mutual from the later of the two gestures.
    ways AS (
      SELECT g.a AS lo, g.b AS hi, 'wave' AS way, GREATEST(g.at, r.at) AS at
        FROM gestures g JOIN gestures r ON r.a = g.b AND r.b = g.a WHERE g.a < g.b
      UNION ALL
      SELECT LEAST(from_user_id, to_user_id), GREATEST(from_user_id, to_user_id), 'lobby', COALESCE(decided_at, created_at)
        FROM board_requests WHERE event_id = ${eventId}::uuid AND status = 'accepted'
      UNION ALL
      SELECT LEAST(sender_id, recipient_id), GREATEST(sender_id, recipient_id), 'request', COALESCE(responded_at, updated_at)
        FROM message_requests WHERE met_in_event_id = ${eventId}::uuid AND status = 'accepted'
    ),
    -- Once per pair however many ways, under the first.
    pairs AS (
      SELECT DISTINCT ON (lo, hi) lo, hi, way FROM ways ORDER BY lo, hi, at, way
    ),
    movers AS (
      SELECT a FROM gestures
      UNION SELECT from_user_id FROM board_requests WHERE event_id = ${eventId}::uuid
      UNION SELECT sender_id FROM message_requests WHERE met_in_event_id = ${eventId}::uuid
    ),
    kept AS (
      SELECT lo, hi, way FROM pairs
       WHERE lo IN (SELECT user_id FROM att) AND hi IN (SELECT user_id FROM att)
    ),
    convs AS (
      SELECT c.id, LEAST(c.user1_id, c.user2_id) AS lo, GREATEST(c.user1_id, c.user2_id) AS hi
        FROM private_conversations c WHERE ${openedInRoom(eventId)}
    ),
    -- A connection that kept talking: its chat has a message from each side. Counts only, never words.
    talking AS (
      SELECT DISTINCT k.lo, k.hi FROM kept k JOIN convs c ON c.lo = k.lo AND c.hi = k.hi
       WHERE EXISTS (SELECT 1 FROM private_messages m WHERE m.conversation_id = c.id AND m.sender_id = k.lo)
         AND EXISTS (SELECT 1 FROM private_messages m WHERE m.conversation_id = c.id AND m.sender_id = k.hi)
    )
    SELECT (SELECT count(*) FROM att)::int AS attendees,
           (SELECT count(*) FROM kept)::int AS connections,
           (SELECT count(*) FROM (SELECT lo FROM kept UNION SELECT hi FROM kept) c)::int AS connected,
           (SELECT count(*) FROM movers WHERE a IN (SELECT user_id FROM att))::int AS reached_out,
           (SELECT count(*) FROM kept WHERE way = 'wave')::int AS waves,
           (SELECT count(*) FROM kept WHERE way = 'lobby')::int AS lobby,
           (SELECT count(*) FROM kept WHERE way = 'request')::int AS requests,
           (SELECT count(*) FROM (SELECT lo FROM talking UNION SELECT hi FROM talking) t)::int AS kept_talking`

  return {
    attendees: row.attendees,
    connections: row.connections,
    connected: row.connected,
    reachedOut: row.reached_out,
    byWay: { waves: row.waves, lobby: row.lobby, requests: row.requests },
    keptTalking: row.kept_talking,
  }
}
