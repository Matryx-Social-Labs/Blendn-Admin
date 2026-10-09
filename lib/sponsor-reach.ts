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
 * ponytail: computed on read from the hashes. The schema plans to materialise
 * reach at the event's end and empty the arrays; until something empties them
 * this is exact, and it must move to the stored figure the day it does.
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
  if (pairs.length === 0) return new Map()
  const eventIds = [...new Set(pairs.map((p) => p.eventId))]
  const sponsorIds = [...new Set(pairs.map((p) => p.sponsorId))]
  const rows = await db.$queryRaw<
    { event_id: string; sponsor_id: string; reach: number; exposures: number; live: number; sends: number }[]
  >`
    WITH per_campaign AS (
      SELECT m.event_id, m.sponsor_id,
             (SELECT count(DISTINCT h)
                FROM sponsored_message_sends s2, unnest(s2.recipient_hashes) AS h
               WHERE s2.sponsored_message_id = m.id) AS reach,
             sum(s.members) AS exposures,
             sum(s.live_connected) AS live,
             count(s.id) AS sends
        FROM event_sponsored_messages m
        JOIN sponsored_message_sends s ON s.sponsored_message_id = m.id
       WHERE m.event_id = ANY(${eventIds}::uuid[]) AND m.sponsor_id = ANY(${sponsorIds}::uuid[])
       GROUP BY m.event_id, m.sponsor_id, m.id
    )
    SELECT event_id::text, sponsor_id::text,
           max(reach)::int AS reach, sum(exposures)::int AS exposures, sum(live)::int AS live, sum(sends)::int AS sends
      FROM per_campaign
     GROUP BY event_id, sponsor_id`
  const wanted = new Set(pairs.map((p) => reachKey(p.eventId, p.sponsorId)))
  const out = new Map<string, PlacementReach>()
  for (const r of rows) {
    const key = reachKey(r.event_id, r.sponsor_id)
    if (!wanted.has(key)) continue
    const reach = discloseHeadcount(r.reach)
    const shown = reach !== null && reach > 0
    out.set(key, {
      reach,
      suppressed: reach === null,
      exposures: shown ? r.exposures : null,
      frequency: shown ? Math.round((r.exposures / reach) * 10) / 10 : null,
      liveSharePct: shown && r.exposures > 0 ? Math.round((r.live / r.exposures) * 100) : null,
      sends: r.sends,
    })
  }
  return out
}
