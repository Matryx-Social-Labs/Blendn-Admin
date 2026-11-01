import { Prisma } from "@prisma/client"

import { cityRuleWhere, type CityRule } from "@/lib/browse-scope"
import { db } from "@/lib/db"
import { realEventsWhere } from "@/lib/event-kind"
import type { LiveCountBucket } from "@/lib/disclosure"
import { liveGuestIds, staleVenueIds, venueLiveBucket } from "@/lib/live-count"
import { logger } from "@/lib/logger"
import { mayAttendWhere, openOnBlendnWhere, undisputedLinkWhere } from "@/lib/venue-visibility"
import { venueDayBounds } from "@/lib/venue-day"
import { tonightHours } from "@/lib/venue-tonight"

/*
 * What `GET /api/mobile/venues` and `GET /api/mobile/venues/summary` both ask,
 * written once: which venues are listed, which events count for one, and who
 * is live or open tonight. A summary that counted a different set from the
 * list it summarises would show "12 places" over a list of 10.
 */

/**
 * The events that count for a venue, both for `upcomingEventCount` and for
 * `nextEvent`, and for "open tonight". One object used in all of them on
 * purpose. When these were allowed to drift on the events side, a card could
 * say "3 upcoming" and then headline an event that was not one of them.
 */
export function upcomingEventsWhere(viewerAge: number | null, now: Date): Prisma.eventsWhereInput {
  return {
    deleted_at: null,
    // A venue's own live room is not an event at it: counted, it would make
    // every venue anyone went live at read "1 upcoming" (F3).
    ...realEventsWhere,
    status: "published" as const,
    visibility: "public" as const,
    end_time: { gte: now },
    /*
     * Two ORs, so under `AND` (F4), and both from lib/venue-visibility.ts,
     * where the takeover reads them. A link the venue's owner disputed is the
     * owner saying the event is not here, so it is no headline here either.
     */
    AND: [undisputedLinkWhere, ...(typeof viewerAge === "number" ? [mayAttendWhere(viewerAge)] : [])],
  }
}

/**
 * The venues Places lists, before the caller's own filters: active and not
 * deleted (`archived` is how a venue is retired without deleting the events
 * that happened in it), not a claimed venue its owner took off Blendn (D-13),
 * and within the city rule (the events filter's, so the two agree on what a
 * city is). Both are under `AND`, so a caller's search `OR` replaces neither.
 */
export function listedVenuesWhere(cityRule: CityRule): Prisma.venuesWhereInput {
  return {
    deleted_at: null,
    status: "active",
    AND: [openOnBlendnWhere, cityRuleWhere(cityRule)],
  }
}

/**
 * `liveNow` for a page of venues, as `GET /venues/:id` reads it for one: the
 * same `liveGuestIds` (one read for the page, never one per venue — HM-I05)
 * and the same per-venue minute cache (`venueLiveBucket`), the caller left
 * out only if counted.
 */
export async function liveBuckets(venueIds: string[], viewerId: string, now: Date) {
  // Guests are read only for venues whose minute-old count has run out: the cache steadies the figure AND saves the read.
  const live = await liveGuestIds(staleVenueIds(venueIds, now.getTime()), now)
  const buckets = await Promise.all(
    venueIds.map((id) =>
      venueLiveBucket(
        id,
        viewerId,
        // An entry that expired between the check above and here is read on its own, never taken for empty.
        async () => live.get(id) ?? (await liveGuestIds([id], now)).get(id) ?? new Set<string>(),
        now.getTime()
      )
    )
  )
  return new Map(venueIds.map((id, i) => [id, buckets[i]]))
}

/** The venues matching `where` whose `liveNow` is not `quiet` for this viewer. */
export async function liveVenueIds(where: Prisma.venuesWhereInput, viewerId: string, now: Date): Promise<Set<string>> {
  /*
   * Distinct in SQL: Prisma's `distinct` runs in JS, so this used to ship one
   * row per live guest in the city to learn which venues have any. The same
   * predicate as `liveGuestsWhere` (live window open, a guest) on a venue day;
   * the caller's venue filter is applied to the few ids that come back.
   */
  const live = await db.$queryRaw<{ venue_id: string }[]>`
    SELECT DISTINCT e.venue_id
      FROM event_check_ins ci
      JOIN events e ON e.id = ci.event_id
     WHERE ci.status = 'checked_in' AND ci.expires_at > ${now} AND ci.kind = 'attendee'
       AND e.kind = 'venue_day' AND e.venue_id IS NOT NULL`
  if (live.length === 0) return new Set()
  const listed = await db.venues.findMany({
    where: { AND: [where, { id: { in: live.map((r) => r.venue_id) } }] },
    select: { id: true },
  })
  const ids = listed.map((v) => v.id)
  const buckets = await liveBuckets(ids, viewerId, now)
  return new Set(ids.filter((id) => buckets.get(id) !== "quiet"))
}

/** How long the open-tonight set is kept per scope, like the live count's minute. */
const TONIGHT_TTL_MS = 60_000
/** The most venues one open-tonight read looks at per source: a scope this large is logged, not walked. */
const TONIGHT_CEILING = 5000
const tonightShared = globalThis as typeof globalThis & { __blendnTonight?: Map<string, { ids: Set<string>; at: number }> }
const tonightCache = (tonightShared.__blendnTonight ??= new Map())

/**
 * The venues matching `where`, not already live, that are open tonight: their
 * hours (`venues.hours`, in the venue's own zone) have a row for the weekday of
 * the venue's current day, or a public event (`eventFilter`, the card's) starts
 * before that day ends. "Tonight" is the venue's day, not the clock's midnight.
 *
 * `where` already carries the query's city / bounding box / search, so a read
 * is scoped to what the caller listed; the result is kept a minute per scope
 * (`scope`), so paging and refreshing do not repeat it.
 */
export async function openTonightVenueIds(
  where: Prisma.venuesWhereInput,
  eventFilter: Prisma.eventsWhereInput,
  now: Date,
  live: ReadonlySet<string>,
  scope: string
): Promise<Set<string>> {
  let entry = tonightCache.get(scope)
  if (!entry || now.getTime() - entry.at >= TONIGHT_TTL_MS) {
    entry = { ids: await readOpenTonight(where, eventFilter, now), at: now.getTime() }
    if (tonightCache.size > 1000) tonightCache.clear()
    tonightCache.set(scope, entry)
  }
  return new Set([...entry.ids].filter((id) => !live.has(id)))
}

async function readOpenTonight(where: Prisma.venuesWhereInput, eventFilter: Prisma.eventsWhereInput, now: Date): Promise<Set<string>> {
  const pick = { id: true, timezone: true, day_reset_hour: true } as const
  // Events starting within a day and a half can start before some venue's day ends; each is checked against its own venue's end below.
  const soon = { ...realEventsWhere, ...eventFilter, start_time: { lt: new Date(now.getTime() + 36 * 3_600_000) } }
  const [withHours, withEvents] = await Promise.all([
    db.venues.findMany({ where: { AND: [where, { hours: { not: Prisma.DbNull } }] }, select: { ...pick, hours: true }, take: TONIGHT_CEILING }),
    db.venues.findMany({
      where: { AND: [where, { events: { some: soon } }] },
      select: { ...pick, events: { where: soon, orderBy: [{ start_time: "asc" }, { id: "asc" }], take: 1, select: { start_time: true } } },
      take: TONIGHT_CEILING,
    }),
  ])
  if (withHours.length === TONIGHT_CEILING || withEvents.length === TONIGHT_CEILING) {
    logger.warn("Open-tonight read hit its ceiling; the tier is truncated", { ceiling: TONIGHT_CEILING })
  }
  const ids = new Set<string>()
  for (const v of withHours) if (isOpenByHours(v, now)) ids.add(v.id)
  for (const v of withEvents) if (startsBeforeDayEnds(v, v.events[0]?.start_time ?? null, now)) ids.add(v.id)
  return ids
}

type DaySpan = { timezone: string; day_reset_hour: number }

/** Hours with a row for the weekday of the venue's current day (its day, not the clock's midnight). */
function isOpenByHours(v: DaySpan & { hours: unknown }, now: Date): boolean {
  return tonightHours(v, now) !== null
}

/** The venue's next public event starts before its current day ends. */
function startsBeforeDayEnds(v: DaySpan, nextStart: Date | null, now: Date): boolean {
  return nextStart !== null && nextStart < venueDayBounds(v.timezone, v.day_reset_hour, now).end
}

/**
 * One venue's tier by the rule `order=live` ranks by: live now (`liveNow` is
 * not `quiet`), else open tonight (`isOpenByHours` or `startsBeforeDayEnds`),
 * else quiet. `nextStart` is its next public event, the card's `nextEvent`.
 */
export function venueTier(
  v: DaySpan & { hours: unknown },
  liveNow: LiveCountBucket,
  nextStart: Date | null,
  now: Date
): "live" | "open" | "quiet" {
  if (liveNow !== "quiet") return "live"
  return isOpenByHours(v, now) || startsBeforeDayEnds(v, nextStart, now) ? "open" : "quiet"
}
