import "server-only"

import type { Prisma } from "@prisma/client"

import { db } from "../db"
import { heldPart } from "../disclosure"
import { hasEntitlement } from "../entitlements"
import { nightsSql, regularsWindow } from "../regulars"

/**
 * A venue's side of regulars and offers (step 12, plan v2 §2): counts, never
 * people — unless a person said yes.
 *
 * **Never a person's id, name or handle from an offer.** What an offer did is
 * three counts. The one list of people is `knownRegulars`, and it is built
 * FROM `venue_regular_optins`: a person is on it because they said "let this
 * venue know I'm a regular", and off it the moment they take that back (no
 * cache). `__tests__/regulars-never-listed.test.ts` holds both.
 *
 * ## Counts that cannot be subtracted into a person
 *
 * `sent` is the audience at send time, never under 5 (refused below that).
 * `opened` is a part of `sent` and `redeemed` a part of `opened`, and each is
 * shown only when it and the rest of its whole both reach 5 (`heldPart`): 12
 * sent and 11 opened would otherwise say one person ignored it, and 6 opened
 * and 5 redeemed that one person opened it and did not come.
 *
 * Venue Pro only, asked here and not by the page: no Pro, no view.
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
  sent: number
  /** Null: held back (fewer than 5 either way). */
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
  known: KnownRegular[]
}

/** What an offer did, as a venue may see it. */
export function offerCounts(sent: number, opened: number, redeemed: number): Pick<OfferResult, "sent" | "opened" | "redeemed"> {
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
 * A claimed venue's offers and the regulars who let it know them, for its
 * owner's organisation (or an admin). Null without Venue Pro, or for a venue
 * nobody owns.
 */
export async function venueOffersView(venueId: string, now: Date = new Date()): Promise<VenueOffersView | null> {
  const v = await db.venues.findFirst({
    where: { id: venueId, deleted_at: null },
    select: { id: true, timezone: true, day_reset_hour: true, claimed_at: true, owner_org_id: true },
  })
  if (!v?.owner_org_id || !v.claimed_at) return null
  if (!(await hasEntitlement({ kind: "venue", id: venueId }, "venue_pro", {}, now))) return null
  const venue = { ...v, claimed_at: v.claimed_at, owner_org_id: v.owner_org_id }
  const { from, to } = regularsWindow(venue, now)

  const [week, offers, known] = await Promise.all([
    sentThisWeek(venueId, now),
    // The current owner's offers only: a venue that changed hands shows nothing of the last owner's.
    db.$queryRaw<{ id: string; text: string; created_at: Date; ends_at: Date; audience_size: number; opened: number; redeemed: number }[]>`
      SELECT o.id::text AS id, o.text, o.created_at, o.ends_at, o.audience_size,
             count(s.opened_at)::int AS opened, count(s.redeemed_at)::int AS redeemed
        FROM venue_offers o
        LEFT JOIN venue_offer_sends s ON s.offer_id = o.id
       WHERE o.venue_id = ${venueId}::uuid AND o.org_id = ${venue.owner_org_id}::uuid
       GROUP BY o.id
       ORDER BY o.created_at DESC
       LIMIT ${OFFERS_SHOWN}`,
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
      ...offerCounts(o.audience_size, o.opened, o.redeemed),
    })),
    known: known.map((k) => ({ firstName: k.first_name || "Someone", nights: k.nights })),
  }
}
