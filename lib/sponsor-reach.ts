import "server-only"

import { db } from "./db"
import { discloseHeadcount } from "./disclosure"

/**
 * Who a sponsor's sends reached (F8; audit §5.4, §6.3). It was hard-coded to
 * null, so placements were priced with no proof of delivery.
 *
 * ## Distinct people, from the hashes the scheduler stores
 *
 * Each send records who was in the room as per-CAMPAIGN HMACs
 * (`sponsored_message_sends.recipient_hashes`, lib/sponsored-scheduler.ts),
 * never user ids. `count(DISTINCT hash)` over a campaign's sends is exactly
 * the distinct people it reached. Across two campaigns the same person has
 * two hashes, by design (no cross-campaign roster), so a placement with two
 * campaigns reports the larger campaign's reach: a floor on what it
 * delivered, never more than it did.
 *
 * ## Stored once the event has ended
 *
 * The hashes are a roster, kept only as long as reach needs them. Two hours
 * after the event ends (past any send the scheduler could still finish),
 * `materialiseEndedReach` (lib/sponsored-scheduler.ts, on its tick) counts
 * each campaign's distinct hashes once, stores the count on the campaign
 * (`event_sponsored_messages.reach`) and empties the arrays, in one
 * statement. Reads take the stored count when there is one and count the
 * hashes while the campaign can still send. Once stored, a rotated
 * `NEXTAUTH_SECRET` can no longer split one person into two.
 *
 * ## Frequency is per campaign
 *
 * Across two campaigns one person has two hashes, so total exposures over
 * the larger campaign's reach would overstate how often anyone saw it. The
 * frequency shown is that campaign's own: its exposures over its reach.
 *
 * ## Held back under 5
 *
 * Reach under `MIN_CELL` is null (`discloseHeadcount`; zero is shown, it
 * names nobody). Exposures, frequency and the live-connected share are given
 * only beside a reach that is shown: with a reach of two, "exposures 6" says
 * how long two people stayed.
 */

export interface PlacementReach {
  /** Distinct people reached, or null when held back (1–4). */
  reach: number | null
  /** True when there was a reach to report and it was under the floor. */
  suppressed: boolean
  /** People-in-room summed over sends: the same person once per send. Null beside a held-back reach. */
  exposures: number | null
  /** Exposures per person reached, to one place. */
  frequency: number | null
  /** Of those exposures, the share with the app open in the room, in percent. */
  liveSharePct: number | null
  sends: number
}

export const reachKey = (eventId: string, sponsorId: string) => `${eventId}:${sponsorId}`

/** Reach for each (event, sponsor) placement asked for; absent when nothing was sent. */
export async function placementReach(pairs: { eventId: string; sponsorId: string }[]): Promise<Map<string, PlacementReach>> {
  // Exactly the pairs asked for, once each: a repeated pair would double its sums.
  const unique = [...new Map(pairs.map((p) => [reachKey(p.eventId, p.sponsorId), p])).values()]
  if (unique.length === 0) return new Map()
  const rows = await db.$queryRaw<
    { event_id: string; sponsor_id: string; reach: number; exposures: number; live: number; sends: number; top_exposures: number }[]
  >`
    WITH wanted AS (
      SELECT * FROM unnest(${unique.map((p) => p.eventId)}::uuid[], ${unique.map((p) => p.sponsorId)}::uuid[]) AS w(event_id, sponsor_id)
    ), per_campaign AS (
      SELECT m.event_id, m.sponsor_id,
             COALESCE(m.reach, (SELECT count(DISTINCT h)
                                  FROM sponsored_message_sends s2, unnest(s2.recipient_hashes) AS h
                                 WHERE s2.sponsored_message_id = m.id))::int AS reach,
             sum(s.members)::int AS exposures,
             sum(s.live_connected)::int AS live,
             count(s.id)::int AS sends
        FROM wanted w
        JOIN event_sponsored_messages m ON m.event_id = w.event_id AND m.sponsor_id = w.sponsor_id
        JOIN sponsored_message_sends s ON s.sponsored_message_id = m.id
       GROUP BY m.event_id, m.sponsor_id, m.id
    )
    SELECT event_id::text, sponsor_id::text,
           max(reach)::int AS reach,
           sum(exposures)::int AS exposures,
           sum(live)::int AS live,
           sum(sends)::int AS sends,
           -- The exposures of the campaign whose reach is reported, for its frequency.
           (array_agg(exposures ORDER BY reach DESC, exposures DESC))[1]::int AS top_exposures
      FROM per_campaign
     GROUP BY event_id, sponsor_id`
  const out = new Map<string, PlacementReach>()
  for (const r of rows) {
    const reach = discloseHeadcount(r.reach)
    const shown = reach !== null && reach > 0
    out.set(reachKey(r.event_id, r.sponsor_id), {
      reach,
      suppressed: reach === null,
      exposures: shown ? r.exposures : null,
      frequency: shown ? Math.round((r.top_exposures / reach) * 10) / 10 : null,
      liveSharePct: shown && r.exposures > 0 ? Math.round((r.live / r.exposures) * 100) : null,
      sends: r.sends,
    })
  }
  return out
}
