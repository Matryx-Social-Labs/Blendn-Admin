import "server-only"

import { Prisma } from "@prisma/client"

import { venueDayBounds } from "./venue-day"

/**
 * Who a venue's regulars are (step 12, plan v2 §2, D-7).
 *
 * **A regular has been at the venue on 3 or more nights in the last 30**,
 * counted from the venue's claim on. Never before it: a claim does not open
 * the venue's past (owner's ruling 1), so the moment a venue is claimed
 * nobody is yet its regular, and the first regulars appear three nights
 * later.
 *
 *   - A night is the venue's day (`day_reset_hour`, 06:00 by default), the
 *     same boundary as venue days and the insights grid: in at 01:00 is last
 *     night. Two check-ins on one night are one night.
 *   - Any night out at the venue counts — a host's event there or the
 *     venue's own live room (Go Live) — as a guest (`kind = 'attendee'`,
 *     checked in). Staff check-ins never count.
 *   - The 30 nights end where today began (the venue's reset), like the
 *     insights window: the audience changes once a day, by whole nights, so
 *     it cannot be watched filling up arrival by arrival.
 *
 * ## Two definitions, two surfaces, on purpose
 *
 * The venue page's "Who comes" panel counts **returning guests — 2+ nights
 * in its window** (`lib/venue-insights.ts`, 30 days on Listed, 12 months on
 * Pro): an aggregate about the venue. An offer goes to **regulars — 3+ nights
 * in 30 days** (this file): people we will push something to, so the bar is
 * higher and the window fixed. The page labels the first "Returning" so the
 * word "regulars" means one thing on the dashboard: who an offer reaches.
 *
 * ## Never a list
 *
 * The audience's ids never leave the database on the way to a send: the send
 * is one `INSERT … SELECT` over `audienceSql` (lib/offer-actions.ts), and
 * only the push sender reads them back (lib/offers/deliver.ts). The one
 * exception is a person's own yes (`venue_regular_optins`).
 */

export const REGULAR_NIGHTS = 3
export const REGULAR_WINDOW_DAYS = 30
/**
 * An account younger than this is never in an audience (review M4): a venue
 * that made five accounts, walked them in on three nights and sent an offer
 * could otherwise read whether one real person joined them.
 */
export const MIN_ACCOUNT_AGE_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

export interface RegularsVenue {
  id: string
  timezone: string
  day_reset_hour: number
  claimed_at: Date
  owner_org_id: string
}

/** The window: 30 whole nights ending where the venue's today began, never before the claim. */
export function regularsWindow(v: RegularsVenue, now: Date = new Date()): { from: Date; to: Date } {
  const to = venueDayBounds(v.timezone, v.day_reset_hour, now).start
  const start = new Date(to.getTime() - REGULAR_WINDOW_DAYS * DAY_MS)
  const from = start > v.claimed_at ? start : v.claimed_at
  // Claimed today: an empty window, never a negative one.
  return { from: from < to ? from : to, to }
}

/**
 * Each guest's nights at the venue in [from, to): rows of (user_id, nights).
 * `onlyUsers` narrows it to those people (the venue's own yeses, review L7).
 * The events are bounded by their dates too, so the venue's years of nights
 * are not walked to find a month (a day either side for a night that ran late
 * or started early).
 */
export function nightsSql(v: RegularsVenue, from: Date, to: Date, onlyUsers?: Prisma.Sql): Prisma.Sql {
  // any-kind: a regular's nights are any nights out at the venue, a host's event or its own live room.
  return Prisma.sql`
    SELECT c.user_id,
           count(DISTINCT ((c.check_in_time AT TIME ZONE ${v.timezone}) - make_interval(hours => ${v.day_reset_hour}))::date)::int AS nights
      FROM event_check_ins c
      JOIN events e ON e.id = c.event_id
     WHERE e.venue_id = ${v.id}::uuid
       AND e.deleted_at IS NULL
       AND e.start_time < ${to}::timestamptz + interval '1 day'
       AND e.end_time > ${from}::timestamptz - interval '1 day'
       AND c.kind = 'attendee'
       AND c.status IN ('checked_in', 'checked_out')
       AND c.check_in_time >= ${from} AND c.check_in_time < ${to}
       ${onlyUsers ? Prisma.sql`AND c.user_id IN (${onlyUsers})` : Prisma.empty}
     GROUP BY c.user_id`
}

/**
 * An adult, by the rule `ageFrom` + `isAdult` apply (lib/age.ts): a plausible
 * date of birth decides, else the stored age; unknown is no. An offer may be
 * a drink, and the app is 18+ (owner, 2026-09-27); accounts from before that
 * ruling can still be younger.
 */
const adultSql = Prisma.sql`
  COALESCE(
    CASE WHEN p.date_of_birth IS NOT NULL
               AND p.date_of_birth <= (now() AT TIME ZONE 'UTC')::date
               AND p.date_of_birth > (now() AT TIME ZONE 'UTC')::date - interval '150 years'
         THEN extract(year FROM age((now() AT TIME ZONE 'UTC')::date, p.date_of_birth))::int
    END,
    p.age
  ) >= 18`

/**
 * The people an offer to "regulars" goes to now: rows of `user_id`.
 *
 * Regulars (above), less anyone who could not or should not get it: a
 * deleted or suspended account, an account under 30 days old, anyone not
 * known to be an adult, anyone who turned "Offers from places" off or muted
 * this venue's offers, and the venue's own people (members of its
 * organisation are its staff, not its guests).
 */
export function audienceSql(v: RegularsVenue, now: Date = new Date()): Prisma.Sql {
  const { from, to } = regularsWindow(v, now)
  return Prisma.sql`
    SELECT n.user_id
      FROM (${nightsSql(v, from, to)}) n
      JOIN "User" u ON u.id = n.user_id
      LEFT JOIN profiles p ON p.id = n.user_id
     WHERE n.nights >= ${REGULAR_NIGHTS}
       AND u."deletedAt" IS NULL
       AND u.suspended_at IS NULL
       AND u."createdAt" <= ${now}::timestamptz - make_interval(days => ${MIN_ACCOUNT_AGE_DAYS})
       AND p.offers_from_places IS DISTINCT FROM false
       AND ${adultSql}
       AND NOT EXISTS (SELECT 1 FROM venue_offer_mutes m WHERE m.venue_id = ${v.id}::uuid AND m.user_id = n.user_id)
       AND NOT EXISTS (SELECT 1 FROM organisation_members om WHERE om.org_id = ${v.owner_org_id}::uuid AND om.user_id = n.user_id)`
}
