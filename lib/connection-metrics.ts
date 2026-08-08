import { db } from "@/lib/db"

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
 * One-sided likes are not counted and are never exposed. A like nobody returned
 * is private to the person who sent it, and an organiser learning how many
 * unreciprocated likes their event produced would be learning something about
 * individuals dressed up as a statistic.
 *
 * ## Suppressed for small rooms
 *
 * Below `MIN_ATTENDEES` these figures identify people. "One connection among
 * three attendees" names both of them to anyone who was there. Aggregates stop
 * being aggregates at small n, and an organiser's curiosity is not worth that.
 */

/**
 * The floor. Chosen so a single connection cannot be attributed: at eight
 * attendees, "3 connections" is 28 possible pairs and tells you nothing about
 * which.
 */
export const MIN_ATTENDEES = 8

export interface ConnectionMetrics {
  /** Distinct guests who checked in. The denominator. */
  attendees: number
  /** Mutual likes — pairs where both people said yes. */
  connections: number
  /** People who made at least one. */
  connected: number
  /** The benchmark figure. Null when suppressed. */
  perAttendee: number | null
  /** Share who made at least one connection. Null when suppressed. */
  connectedPct: number | null
  /**
   * Too few attendees for these to be aggregates rather than facts about named
   * people. Everything derived is null; `attendees` still shows.
   */
  suppressed: boolean
}

export async function getConnectionMetrics(eventId: string): Promise<ConnectionMetrics> {
  const [attendeeRows, likes] = await Promise.all([
    db.event_check_ins.findMany({
      where: { event_id: eventId, check_in_time: { not: null }, kind: "attendee" },
      distinct: ["user_id"],
      select: { user_id: true },
    }),
    db.event_likes.findMany({
      where: { event_id: eventId },
      select: { liker_id: true, liked_id: true },
    }),
  ])

  const attendees = attendeeRows.length

  if (attendees < MIN_ATTENDEES) {
    return {
      attendees,
      connections: 0,
      connected: 0,
      perAttendee: null,
      connectedPct: null,
      suppressed: true,
    }
  }

  /*
   * A pair counts once. Walking the likes and asking whether the reverse exists
   * would count every mutual pair twice, which is the kind of error that reads
   * as a good result.
   *
   * In memory rather than SQL: likes are bounded by attendance squared, and at
   * the sizes this product sees that is far cheaper than a self-join. If an
   * event ever produces enough likes for this to matter, it wants a raw query
   * and a different problem to solve.
   */
  const sent = new Set(likes.map((l) => `${l.liker_id}|${l.liked_id}`))
  const connectedPeople = new Set<string>()
  let connections = 0

  for (const { liker_id, liked_id } of likes) {
    if (!sent.has(`${liked_id}|${liker_id}`)) continue
    connectedPeople.add(liker_id)
    connectedPeople.add(liked_id)
    // Count the pair from one side only.
    if (liker_id < liked_id) connections += 1
  }

  return {
    attendees,
    connections,
    connected: connectedPeople.size,
    // One decimal: "1.4 each" is a real distinction from "1 each", and two
    // decimals would imply a precision a room of forty cannot support.
    perAttendee: Math.round((connections / attendees) * 10) / 10,
    connectedPct: Math.round((connectedPeople.size / attendees) * 100),
    suppressed: false,
  }
}
