import "server-only"

import type { Prisma, user_role } from "@prisma/client"

import { db } from "../db"
import { heldPart } from "../disclosure"
import { hasEntitlement } from "../entitlements"
import { actorFor } from "../org-membership"
import { nightsSql, regularsWindow } from "../regulars"

/**
 * A venue's side of regulars and offers (step 12, plan v2 §2): counts, never
 * people — unless a person said yes.
 *
 * ## Whose view
 *
 * Asked here, not by the page: an admin, or an active member of the
 * organisation that owns the venue now (`actorFor`, `owner_org_id`), on Venue
 * Pro. Everyone else gets null. Offers belong to the organisation that sent
 * them (`venue_offers.org_id`): the view reads only the current owner's, so a
 * venue that changes hands shows its new owner nothing of the last one's, and
 * the last one — who no longer owns the venue — is not a viewer at all.
 *
 * ## Never a person's id, name or handle from an offer
 *
 * What offers did is counts. The one list of people is `known`, built FROM
 * `venue_regular_optins`: a person is on it because they said "let this
 * venue know I'm a regular", and off it the moment they take it back (no
 * cache). `__tests__/regulars-never-listed.test.ts` holds both.
 *
 * ## Counts that cannot be differenced into a person
 *
 *   - **Per offer, only what the venue already knows:** its words, its dates,
 *     and how many it went to — the audience at send time, never under 5 (an
 *     audience under 5 is refused with one fixed sentence and no count).
 *   - **Opened and redeemed only as totals across all of this organisation's
 *     offers at the venue** (the rule chosen against overlapping sends: two
 *     sends to nearly the same few regulars cannot be compared, because no
 *     send has results of its own). A total is shown only when it and the rest
 *     of its whole both reach 5 (`heldPart`): opened against sent, redeemed
 *     against opened.
 *   - **Up to where the venue's day began** (its reset, 06:00 by default):
 *     offers sent, opened and redeemed today count from tomorrow. The totals
 *     move once a day, so "it went up by one just after she walked in" is not
 *     a thing a reload can show.
 *
 * Cumulative, never a rolling window: a window would drop an old offer's
 * opens on the day it aged out, and the drop would be that offer's own count.
 */

export const OFFERS_PER_WEEK = 2
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const OFFERS_SHOWN = 20
const KNOWN_SHOWN = 200

export interface OfferResult {
  id: string
  text: string
  createdAt: string
  endsAt: string
  live: boolean
  /** How many it went to: the audience at send time, never under 5. */
  sent: number
}

/** What all of the organisation's offers here did, up to `asOf`. */
export interface OfferTotals {
  /** Where the counted day ended: the start of the venue's today. */
  asOf: string
  sent: number
  /** Null: held back (it, or the rest of its whole, under 5). */
  opened: number | null
  redeemed: number | null
}

export interface KnownRegular {
  firstName: string
  /** Nights here in the last 30, from the claim on. */
  nights: number
}

export interface VenueOffersView {
  perWeek: number
  /** Offers sent from this venue in the last 7 days. */
  sentThisWeek: number
  /** When the next one may go, while the week's are used. */
  nextAt: string | null
  offers: OfferResult[]
  totals: OfferTotals
  known: KnownRegular[]
}

/** Opened and redeemed, as a venue may see them against what was sent. */
export function offerCounts(sent: number, opened: number, redeemed: number): Pick<OfferTotals, "sent" | "opened" | "redeemed"> {
  return { sent, opened: heldPart(opened, sent), redeemed: heldPart(redeemed, opened) }
}

/** This week's sends at a venue, oldest first: the quota and when it frees. */
export async function sentThisWeek(venueId: string, now: Date, client: Prisma.TransactionClient | typeof db = db): Promise<Date[]> {
  const rows = await client.venue_offers.findMany({
    where: { venue_id: venueId, created_at: { gt: new Date(now.getTime() - WEEK_MS) } },
    orderBy: { created_at: "asc" },
    select: { created_at: true },
  })
  return rows.map((r) => r.created_at)
}

/** When the next offer may go, or null while there is room this week. */
export function nextOfferAt(week: Date[]): Date | null {
  return week.length < OFFERS_PER_WEEK ? null : new Date(week[week.length - OFFERS_PER_WEEK].getTime() + WEEK_MS)
}

/**
 * A claimed venue's offers, their totals and the regulars who let it know
 * them — for an admin or the owning organisation's members, on Venue Pro.
 * Null for anyone else, without Pro, or for a venue nobody owns.
 */
export async function venueOffersView(
  venueId: string,
  viewer: { id: string; role: user_role },
  now: Date = new Date()
): Promise<VenueOffersView | null> {
  const v = await db.venues.findFirst({
    where: { id: venueId, deleted_at: null },
    select: { id: true, timezone: true, day_reset_hour: true, claimed_at: true, owner_org_id: true },
  })
  if (!v?.owner_org_id || !v.claimed_at) return null
  if (viewer.role !== "app_admin" && !(await actorFor(viewer)).orgIds.includes(v.owner_org_id)) return null
  if (!(await hasEntitlement({ kind: "venue", id: venueId }, "venue_pro", {}, now))) return null
  const venue = { ...v, claimed_at: v.claimed_at, owner_org_id: v.owner_org_id }
  // `to` is where the venue's today began: the regulars' window and the totals both stop there.
  const { from, to } = regularsWindow(venue, now)

  const [week, offers, totals, known] = await Promise.all([
    sentThisWeek(venueId, now),
    // The current owner's offers: a venue that changed hands shows nothing of the last owner's.
    db.venue_offers.findMany({
      where: { venue_id: venueId, org_id: venue.owner_org_id },
      orderBy: { created_at: "desc" },
      take: OFFERS_SHOWN,
      select: { id: true, text: true, created_at: true, ends_at: true, audience_size: true },
    }),
    // Totals across those offers, up to where today began.
    db.$queryRaw<{ sent: number; opened: number; redeemed: number }[]>`
      SELECT coalesce((SELECT sum(audience_size) FROM venue_offers
                        WHERE venue_id = ${venueId}::uuid AND org_id = ${venue.owner_org_id}::uuid AND created_at < ${to}), 0)::int AS sent,
             (count(s.opened_at) FILTER (WHERE s.opened_at < ${to}))::int AS opened,
             (count(s.redeemed_at) FILTER (WHERE s.redeemed_at < ${to}))::int AS redeemed
        FROM venue_offers o
        JOIN venue_offer_sends s ON s.offer_id = o.id
       WHERE o.venue_id = ${venueId}::uuid AND o.org_id = ${venue.owner_org_id}::uuid AND o.created_at < ${to}`,
    // FROM the yes: nobody is on this list who did not put themselves there.
    db.$queryRaw<{ first_name: string; nights: number }[]>`
      SELECT split_part(btrim(coalesce(p.name, '')), ' ', 1) AS first_name, coalesce(n.nights, 0)::int AS nights
        FROM venue_regular_optins r
        JOIN "User" u ON u.id = r.user_id
        LEFT JOIN profiles p ON p.id = r.user_id
        LEFT JOIN (${nightsSql(venue, from, to)}) n ON n.user_id = r.user_id
       WHERE r.venue_id = ${venueId}::uuid
         AND u."deletedAt" IS NULL
         AND u.suspended_at IS NULL
       ORDER BY nights DESC, first_name
       LIMIT ${KNOWN_SHOWN}`,
  ])

  const next = nextOfferAt(week)
  const t = totals[0] ?? { sent: 0, opened: 0, redeemed: 0 }
  return {
    perWeek: OFFERS_PER_WEEK,
    sentThisWeek: week.length,
    nextAt: next?.toISOString() ?? null,
    offers: offers.map((o) => ({
      id: o.id,
      text: o.text,
      createdAt: o.created_at.toISOString(),
      endsAt: o.ends_at.toISOString(),
      live: o.ends_at > now,
      sent: o.audience_size,
    })),
    totals: { asOf: to.toISOString(), ...offerCounts(t.sent, t.opened, t.redeemed) },
    known: known.map((k) => ({ firstName: k.first_name || "Someone", nights: k.nights })),
  }
}
