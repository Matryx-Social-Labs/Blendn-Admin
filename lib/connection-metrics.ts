import { db } from "@/lib/db"
import { discloseFigure, heldPart } from "@/lib/disclosure"

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
 * Passed to `discloseFigure` as a parameter instead of being a second
 * suppression rule living in its own file — which is what it was, and why the
 * codebase had two floors that had never been reconciled.
 */
export const MIN_ATTENDEES = 8

export interface ConnectionMetrics {
  /** Distinct guests who checked in. The denominator. */
  attendees: number
  /**
   * Pairs of attendees who met here, once per pair however many ways: mutual
   * waves (or a like answered either way), an accepted Lobby ask, an accepted
   * message request sent from this room. Never which pairs.
   */
  connections: number
  /** People who made at least one. */
  connected: number
  /**
   * The benchmark figure: connections per person, counted from each person's
   * side, so a pair is one connection for each of the two (2 x pairs /
   * attendees). Null when suppressed.
   */
  perAttendee: number | null
  /** Share who made at least one connection. Null when suppressed. */
  connectedPct: number | null
  /**
   * Share of attendees who made at least one first move here: a wave (or an
   * old like), a Lobby ask, a message request from this room, answered or not
   * (approval 2). Never a count of waves and never how many went unanswered.
   * Null under the pairs floor, and when the movers or the rest are fewer than
   * `MIN_CELL` (`heldPart`): "6 of 10" names the 4 who sat it out. Not
   * rendered yet; the "Did people meet" funnel reads it.
   */
  reachedOutPct: number | null
  /**
   * Too few attendees for these to be aggregates rather than facts about named
   * people. Everything derived is null; `attendees` still shows.
   */
  suppressed: boolean
}

export async function getConnectionMetrics(eventId: string): Promise<ConnectionMetrics> {
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
   * `UNION` on the ordered pair (lo, hi) is what counts a pair once however
   * many ways they met. Only pairs of two attendees count, so the share who
   * met someone is a share of the people who came.
   *
   * In SQL, not memory: recorded waves at a concert are attendance squared
   * (G3). Nothing but the three counts leaves the database.
   */
  // board-visibility: accepted asks only, and a silenced ask is stored `declined`; a count, to nobody's side.
  const [row] = await db.$queryRaw<{ attendees: number; connections: number; connected: number; reached_out: number }[]>`
    WITH att AS (
      SELECT DISTINCT user_id FROM event_check_ins
       WHERE event_id = ${eventId}::uuid AND check_in_time IS NOT NULL AND kind = 'attendee'
    ),
    gestures AS (
      SELECT liker_id AS a, liked_id AS b FROM event_likes WHERE event_id = ${eventId}::uuid
      UNION
      SELECT from_id, to_id FROM event_waves WHERE event_id = ${eventId}::uuid
    ),
    pairs AS (
      SELECT g.a AS lo, g.b AS hi FROM gestures g JOIN gestures r ON r.a = g.b AND r.b = g.a WHERE g.a < g.b
      UNION
      SELECT LEAST(from_user_id, to_user_id), GREATEST(from_user_id, to_user_id)
        FROM board_requests WHERE event_id = ${eventId}::uuid AND status = 'accepted'
      UNION
      SELECT LEAST(sender_id, recipient_id), GREATEST(sender_id, recipient_id)
        FROM message_requests WHERE met_in_event_id = ${eventId}::uuid AND status = 'accepted'
    ),
    movers AS (
      SELECT a FROM gestures
      UNION SELECT from_user_id FROM board_requests WHERE event_id = ${eventId}::uuid
      UNION SELECT sender_id FROM message_requests WHERE met_in_event_id = ${eventId}::uuid
    ),
    kept AS (
      SELECT lo, hi FROM pairs
       WHERE lo IN (SELECT user_id FROM att) AND hi IN (SELECT user_id FROM att)
    )
    SELECT (SELECT count(*) FROM att)::int AS attendees,
           (SELECT count(*) FROM kept)::int AS connections,
           (SELECT count(*) FROM (SELECT lo FROM kept UNION SELECT hi FROM kept) c)::int AS connected,
           (SELECT count(*) FROM movers WHERE a IN (SELECT user_id FROM att))::int AS reached_out`

  const { attendees, connections, connected, reached_out } = row

  /*
   * The same rule the digest uses, with this figure's own floor.
   *
   * `population: attendees` and `contributors: attendees` because every
   * attendee is a possible participant in a pair -- so only the minimum-cell
   * part of the rule can fire here, which is the part this file always had.
   * Routing through the module anyway is the point: a second implementation is
   * how the two floors drifted apart in the first place.
   */
  const gate = discloseFigure({
    count: attendees,
    contributors: attendees,
    population: attendees,
    floor: MIN_ATTENDEES,
  })

  if (gate.suppressed && gate.reason === "min_cell") {
    return {
      attendees,
      connections: 0,
      connected: 0,
      perAttendee: null,
      connectedPct: null,
      reachedOutPct: null,
      suppressed: true,
    }
  }

  return {
    attendees,
    connections,
    connected,
    // Each pair is a connection for both people in it. Dividing pairs by heads
    // (F2) reported half the figure the benchmark it is compared against means.
    // One decimal: "1.4 each" is a real distinction from "1 each", and two
    // decimals would imply a precision a room of forty cannot support.
    perAttendee: Math.round(((2 * connections) / attendees) * 10) / 10,
    connectedPct: Math.round((connected / attendees) * 100),
    reachedOutPct: pctOf(heldPart(reached_out, attendees), attendees),
    suppressed: false,
  }
}

const pctOf = (part: number | null, whole: number) => (part === null ? null : Math.round((part / whole) * 100))
