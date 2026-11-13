import { connectionCounts, MIN_ATTENDEES } from "@/lib/connection-metrics"
import { distinctAttendeeCounts } from "@/lib/attendee-counts"
import { db } from "@/lib/db"
import {
  discloseGroup,
  discloseStars,
  fewCount,
  liveCountBucket,
  liveCountLabel,
  MIN_CELL,
  spreadsByEventId,
  type FewCount,
  type StarSpread,
} from "@/lib/disclosure"
import { hostsEvent } from "@/lib/event-visibility"
import type { InsightCounts } from "@/lib/insight-tallies"
import { publishedRatingGroups } from "@/lib/rating-batches"
import { venueDayBounds } from "@/lib/venue-day"

/**
 * "Nights here" (Venue C, SCRUM-1051, approvals 8 and 9): one row per night at
 * a venue, as its owner is told it. Bands and plain words on every count of
 * people, and how people met only on the venue's own nights, its venue days.
 * On a night another host runs, that cell is the host's, and says so.
 *
 * The disclosers are pure and exported, so each is brute-forced on its own
 * (`__tests__/venue-nights.test.ts`); only words and disclosed parts leave.
 */

/** Met someone, in words, smallest first. Never "everyone": the last few left out would be named by it. */
export const MET_RANGES = ["nobody", "under a quarter", "about a third", "about half", "most", "nearly all"] as const
export type MetRange = (typeof MET_RANGES)[number]

/** The share of guests in at least one connection, as a range; held under the pairs floor (`MIN_ATTENDEES`), like the host's. */
export function metRange(connected: number, attendees: number): MetRange | "held" {
  if (attendees < MIN_ATTENDEES) return "held"
  if (connected <= 0) return "nobody"
  const share = connected / attendees
  if (share < 0.25) return "under a quarter"
  if (share < 0.45) return "about a third"
  if (share < 0.65) return "about half"
  if (share < 0.85) return "most"
  return "nearly all"
}

/** "Mostly" a mood from three in five of the messages: 6 against 5 is mixed, not mostly anything. */
const MOSTLY = 0.6

export type MoodWord = "mostly positive" | "mostly neutral" | "mostly negative" | "mixed" | "a few messages"

/** A night's mood as a venue sees it: positive, neutral, negative through `discloseGroup`, and a word read from those alone. */
export interface VenueMood {
  parts: [FewCount, FewCount, FewCount]
  word: MoodWord
}

/**
 * The venue's mood (owner, 2026-11-13: hosts keep exact mood; venues get the
 * suppressed version). Each mood under five is a few, and the word is read
 * from the disclosed parts only, a few counting as nothing beside a shown
 * part, so two nights that disclose the same read the same. Null when nothing
 * was classified: no mood, not a neutral one.
 */
export function venueMood(c: { positive: number; neutral: number; negative: number }): VenueMood | null {
  const { parts, total } = discloseGroup([c.positive, c.neutral, c.negative])
  const whole = typeof total === "number" ? total : total.atLeast
  if (whole === 0) return null
  const shown = parts.map((p) => (p === "few" ? 0 : p))
  const word: MoodWord =
    shown.every((p) => p === 0)
      ? "a few messages"
      : shown[0] >= whole * MOSTLY
        ? "mostly positive"
        : shown[2] >= whole * MOSTLY
          ? "mostly negative"
          : shown[1] >= whole * MOSTLY
            ? "mostly neutral"
            : "mixed"
  return { parts: parts as VenueMood["parts"], word }
}

/** Who came, as every venue surface prints it: a band. */
export const cameBand = (people: number): string => liveCountLabel(liveCountBucket(people))

/** Offers redeemed on a night: none, under 5, then bands. The venue's own door redeems each one. */
export const offersBand = (redeemed: number): string =>
  redeemed === 0 ? "none" : redeemed < MIN_CELL ? "under 5" : liveCountLabel(liveCountBucket(redeemed))

/** Crews here: a few under five whatever the people (two crews already say four people). */
export function crewsCell(crews: FewCount): string {
  if (crews === 0) return "none"
  return fewCount(crews === "few" ? 1 : crews) === "few" ? "a few" : String(crews)
}

/** The night's stars as an average, held under five raters, null when nobody rated. */
export function ratingCell(spread: StarSpread): string | null {
  const { averageRating, ratingCount } = discloseStars(spread)
  if (ratingCount === 0) return null
  return averageRating === null ? "held" : averageRating.toFixed(1)
}

export interface VenueNightRow {
  id: string
  startAt: string
  /** "Thu 12 Nov", in the venue's zone. */
  night: string
  /** The venue's own live room that day, rather than a host's night. */
  venueDay: boolean
  /** "Your room" on a venue day, else the host's name. */
  host: string
  status: string
  came: string
  /** A range on the venue's own nights; `"hosts"` on another host's night. */
  met: MetRange | "held" | "hosts"
  mood: VenueMood | null
  rating: string | null
  /** Venue days only: the venue's night is a venue day's date. Null elsewhere. */
  offers: string | null
}

/** Rows at most, as the events table before it. */
const NIGHTS_SHOWN = 200
/** Unfrozen own nights read their pairs this many at a time, not all at once on one page load. */
const MET_READS_AT_ONCE = 4

type Actor = { id: string; orgIds: readonly string[] } | null

/**
 * The venue's nights in `startTime` (its claim window, or an admin's range).
 * `actor` null is an admin: every night reads as the venue's own.
 */
export async function venueNights(
  venue: { id: string; owner_org_id: string | null; timezone: string; day_reset_hour: number },
  startTime: { gte: Date; lt?: Date } | null,
  actor: Actor
): Promise<VenueNightRow[]> {
  if (startTime === null) return []
  const events = await db.events.findMany({
    /*
     * any-kind: the hosts' nights AND the venue's own venue days. A venue day
     * is the one night here that is the venue's (approval 9), and the table is
     * where its night shows; another host's night shows what the venue may
     * see of it, and how people met stays the host's.
     */
    where: { venue_id: venue.id, deleted_at: null, start_time: startTime },
    orderBy: { start_time: "desc" },
    take: NIGHTS_SHOWN,
    select: {
      id: true,
      kind: true,
      start_time: true,
      status: true,
      organizer_id: true,
      organizer_org_id: true,
      organizer_org: { select: { display_name: true } },
      organizer: { select: { name: true } },
    },
  })
  if (events.length === 0) return []
  const ids = events.map((e) => e.id)
  const own = new Set(events.filter((e) => e.kind === "venue_day" || !actor || hostsEvent(actor, e)).map((e) => e.id))
  const venueDays = events.filter((e) => e.kind === "venue_day")

  const [came, moods, ratingRows, met, offers] = await Promise.all([
    distinctAttendeeCounts(ids),
    db.event_feedback.groupBy({ by: ["event_id", "sentiment"], where: { event_id: { in: ids } }, _count: { _all: true } }),
    publishedRatingGroups({ id: { in: ids } }),
    metByNight([...own]),
    venueDays.length && venue.owner_org_id ? redeemedByNight(venue.id, venue.owner_org_id) : new Map<string, number>(),
  ])
  const spreads = spreadsByEventId(ratingRows)
  const night = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: venue.timezone })
  const moodOf = (id: string) => {
    const c = { positive: 0, neutral: 0, negative: 0 }
    for (const m of moods) if (m.event_id === id) c[m.sentiment] += m._count._all
    return venueMood(c)
  }

  return events.map((e) => {
    const venueDay = e.kind === "venue_day"
    const pairs = met.get(e.id)
    return {
      id: e.id,
      startAt: e.start_time.toISOString(),
      night: night.format(e.start_time),
      venueDay,
      host: venueDay ? "Your room" : (e.organizer_org?.display_name ?? e.organizer?.name ?? "—"),
      status: e.status,
      came: cameBand(came.get(e.id) ?? 0),
      met: !own.has(e.id) ? "hosts" : metRange(pairs?.connected ?? 0, pairs?.attendees ?? 0),
      mood: moodOf(e.id),
      rating: ratingCell(spreads.get(e.id) ?? [0, 0, 0, 0, 0]),
      offers: venueDay ? offersBand(offers.get(venueDayBounds(venue.timezone, venue.day_reset_hour, e.start_time).localDate) ?? 0) : null,
    }
  })
}

/**
 * Who met someone, per own night: the frozen tally where the night has one
 * (the counts survive the purges), else counted now, a few at a time.
 */
async function metByNight(ids: string[]): Promise<Map<string, { connected: number; attendees: number }>> {
  const out = new Map<string, { connected: number; attendees: number }>()
  if (ids.length === 0) return out
  const frozen = await db.event_insight_tallies.findMany({ where: { event_id: { in: ids } }, select: { event_id: true, counts: true } })
  for (const t of frozen) {
    const { connected, attendees } = (t.counts as unknown as InsightCounts).connections
    out.set(t.event_id, { connected, attendees })
  }
  const unfrozen = ids.filter((id) => !out.has(id))
  // ponytail: a few at a time on the page load; a batched statement if a venue's window ever holds hundreds of unfrozen nights.
  for (let i = 0; i < unfrozen.length; i += MET_READS_AT_ONCE) {
    const batch = unfrozen.slice(i, i + MET_READS_AT_ONCE)
    const counts = await Promise.all(batch.map((id) => connectionCounts(id)))
    batch.forEach((id, j) => out.set(id, { connected: counts[j].connected, attendees: counts[j].attendees }))
  }
  return out
}

/** Offers redeemed per venue night (its local date), the current owner's offers only (a transfer starts afresh). */
async function redeemedByNight(venueId: string, ownerOrgId: string): Promise<Map<string, number>> {
  const rows = await db.venue_offer_sends.groupBy({
    by: ["redeemed_night"],
    where: { venue_id: venueId, redeemed_night: { not: null }, offer: { org_id: ownerOrgId } },
    _count: { _all: true },
  })
  return new Map(rows.flatMap((r) => (r.redeemed_night ? [[r.redeemed_night.toISOString().slice(0, 10), r._count._all] as const] : [])))
}
