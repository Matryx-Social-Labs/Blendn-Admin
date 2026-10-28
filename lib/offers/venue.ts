import "server-only"

import { Prisma, type user_role } from "@prisma/client"

import { db } from "../db"
import { heldPart, MIN_CELL } from "../disclosure"
import { hasEntitlement } from "../entitlements"
import { actorFor } from "../org-membership"
import { nightsSql, regularsWindow } from "../regulars"
import { venueDayBounds } from "../venue-day"

/**
 * A venue's side of regulars and offers (step 12, plan v2 §2): counts, never
 * people — unless a person said yes to this venue's owner.
 *
 * ## Whose view
 *
 * Asked here, not by the page: an admin, or an active member of the
 * organisation that owns the venue now (`actorFor`, `owner_org_id`), on Venue
 * Pro. Everyone else gets null. Offers belong to the organisation that sent
 * them (`venue_offers.org_id`), and a yes to the organisation it was given to
 * (`venue_regular_optins.org_id`): after a transfer the new owner sees none of
 * either, and the last owner is not a viewer at all.
 *
 * ## Never a person's id, name or handle from an offer
 *
 * What offers did is counts. The one list of people is `known`, built FROM
 * `venue_regular_optins` for the current owner: a person is on it because they
 * said "let this venue know I'm a regular", and off it the moment they take it
 * back (no cache). `__tests__/regulars-never-listed.test.ts` holds both.
 *
 * ## Counts that cannot be differenced into a person (reviews M1, M4)
 *
 *   - **How many an offer reached is a band** — 5–9, 10–24, 25–49, 50+ —
 *     never the number, so two sends cannot be subtracted into "one more
 *     regular", and a mute does not visibly move it. Under 5 is refused with one
 *     fixed sentence, whatever the size.
 *   - **Opened and redeemed are totals across all of the organisation's offers
 *     here** — no offer has results of its own to intersect with another's —
 *     **published once a week**, at the venue-day start of each Monday.
 *   - **A week is published only if differencing it gives nothing away**
 *     (`publishedTotals`): every offer sent that week passes the complement
 *     rule on its own (opened against its audience), and what changed since the
 *     last published week passes it too (opened against sent, redeemed against
 *     opened; a week with no new redemptions is no news). Otherwise the last
 *     published week stands, and the change rolls into the next one.
 *   - Each total shown passes the complement rule against its whole (`heldPart`).
 *
 * Cumulative, never a rolling window: a window would drop an old offer's opens
 * on the day it aged out, and the drop would be that offer's own count.
 */

export const OFFERS_PER_WEEK = 2
const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS
const OFFERS_SHOWN = 20
const KNOWN_SHOWN = 200
/** Two years of weeks at most: older history is folded into the first. */
const MAX_WEEKS = 104

export type AudienceBand = "5–9" | "10–24" | "25–49" | "50+"

/** How many, as a venue is told it. Null under the floor (an audience that small is never sent to). */
export function audienceBand(n: number): AudienceBand | null {
  if (n < MIN_CELL) return null
  if (n < 10) return "5–9"
  if (n < 25) return "10–24"
  if (n < 50) return "25–49"
  return "50+"
}

export interface OfferResult {
  id: string
  text: string
  createdAt: string
  endsAt: string
  live: boolean
  /** How many it went to, as a band. */
  reached: AudienceBand | null
}

/** What all of the organisation's offers here did, as of the last published week. */
export interface OfferTotals {
  /** The week's start this is as of; null while no week has been published. */
  asOf: string | null
  sent: AudienceBand | null
  /** Null: held back (it, or the rest of its whole, under 5). */
  opened: number | null
  redeemed: number | null
}

export interface KnownRegular {
  /**
   * The platform's admin only; null for the venue (SCRUM-887, owner ruling
   * 2026-10-28). A host never learns who someone is, and saying yes to "let
   * this venue know I'm a regular" puts them on this list as a regular, with
   * their nights, not by name.
   */
  firstName: string | null
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

/** Where the venue's week containing `at` began: its Monday's day start (the reset hour, its zone). */
export function weekStart(timezone: string, resetHour: number, at: Date): Date {
  const day = venueDayBounds(timezone, resetHour, at)
  const back = (new Date(`${day.localDate}T00:00:00Z`).getUTCDay() + 6) % 7
  if (back === 0) return day.start
  // Midday of the Monday, so a clock change either side cannot land in the wrong day.
  return venueDayBounds(timezone, resetHour, new Date(day.start.getTime() - back * DAY_MS + 12 * 60 * 60 * 1000)).start
}

/** Every week start after `first` up to the one containing `now`, at most `MAX_WEEKS`. */
export function weekBoundaries(timezone: string, resetHour: number, first: Date, now: Date): Date[] {
  const last = weekStart(timezone, resetHour, now)
  const out: Date[] = []
  let b = weekStart(timezone, resetHour, new Date(weekStart(timezone, resetHour, first).getTime() + WEEK_MS + 12 * 60 * 60 * 1000))
  while (b <= last) {
    out.push(b)
    b = weekStart(timezone, resetHour, new Date(b.getTime() + WEEK_MS + 12 * 60 * 60 * 1000))
  }
  return out.slice(-MAX_WEEKS)
}

/** One offer's counts before each boundary, in the boundaries' order. */
export interface OfferHistory {
  createdAt: Date
  sent: number
  opened: number[]
  redeemed: number[]
}

/**
 * The totals a venue may see: the latest week whose change since the last
 * published week gives nothing away (see the file's header). Pure: the
 * snapshots are replayed from the start each time, so the same data always
 * publishes the same weeks.
 */
export function publishedTotals(boundaries: Date[], offers: OfferHistory[]): OfferTotals {
  let published = { at: null as Date | null, sent: 0, opened: 0, redeemed: 0 }
  boundaries.forEach((b, i) => {
    const prev = i === 0 ? null : boundaries[i - 1]
    const before = offers.filter((o) => o.createdAt < b)
    const sent = before.reduce((n, o) => n + o.sent, 0)
    const opened = before.reduce((n, o) => n + o.opened[i], 0)
    const redeemed = before.reduce((n, o) => n + o.redeemed[i], 0)
    // Each offer sent this week, on its own.
    const thisWeek = before.filter((o) => !prev || o.createdAt >= prev)
    if (thisWeek.some((o) => heldPart(o.opened[i], o.sent) === null)) return
    // What changed since the last published week.
    const dSent = sent - published.sent
    const dOpened = opened - published.opened
    const dRedeemed = redeemed - published.redeemed
    if (!(dSent === 0 && dOpened === 0) && heldPart(dOpened, dSent) === null) return
    if (dRedeemed !== 0 && heldPart(dRedeemed, dOpened) === null) return
    published = { at: b, sent, opened, redeemed }
  })
  return {
    asOf: published.at?.toISOString() ?? null,
    sent: audienceBand(published.sent),
    opened: published.at ? heldPart(published.opened, published.sent) : null,
    redeemed: published.at ? heldPart(published.redeemed, published.opened) : null,
  }
}

/** The organisation's offers here, each with its counts before every boundary. */
async function histories(venueId: string, orgId: string, boundaries: Date[]): Promise<OfferHistory[]> {
  if (boundaries.length === 0) return []
  const rows = await db.$queryRaw<{ id: string; created_at: Date; audience_size: number; i: number; opened: number; redeemed: number }[]>`
    SELECT o.id::text AS id, o.created_at, o.audience_size, b.i::int AS i,
           (count(s.opened_at) FILTER (WHERE s.opened_at < b.t))::int AS opened,
           (count(s.redeemed_at) FILTER (WHERE s.redeemed_at < b.t))::int AS redeemed
      FROM venue_offers o
      CROSS JOIN unnest(${boundaries}::timestamptz[]) WITH ORDINALITY AS b(t, i)
      LEFT JOIN venue_offer_sends s ON s.offer_id = o.id
     WHERE o.venue_id = ${venueId}::uuid AND o.org_id = ${orgId}::uuid
     GROUP BY o.id, b.t, b.i`
  const byOffer = new Map<string, OfferHistory>()
  for (const r of rows) {
    const h = byOffer.get(r.id) ?? {
      createdAt: r.created_at,
      sent: r.audience_size,
      opened: boundaries.map(() => 0),
      redeemed: boundaries.map(() => 0),
    }
    h.opened[r.i - 1] = r.opened
    h.redeemed[r.i - 1] = r.redeemed
    byOffer.set(r.id, h)
  }
  return [...byOffer.values()]
}

/**
 * A claimed venue's offers, their published totals and the regulars who let
 * its owner know them — for an admin or the owning organisation's members, on
 * Venue Pro. Null for anyone else, without Pro, or for a venue nobody owns.
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
  const { from, to } = regularsWindow(venue, now)

  const [week, offers, first, known] = await Promise.all([
    sentThisWeek(venueId, now),
    // The current owner's offers: a venue that changed hands shows nothing of the last owner's.
    db.venue_offers.findMany({
      where: { venue_id: venueId, org_id: venue.owner_org_id },
      orderBy: { created_at: "desc" },
      take: OFFERS_SHOWN,
      select: { id: true, text: true, created_at: true, ends_at: true, audience_size: true },
    }),
    db.venue_offers.findFirst({
      where: { venue_id: venueId, org_id: venue.owner_org_id },
      orderBy: { created_at: "asc" },
      select: { created_at: true },
    }),
    // FROM the yeses to this owner: nobody is on this list who did not put themselves there.
    db.$queryRaw<{ first_name: string; nights: number }[]>`
      SELECT split_part(btrim(coalesce(p.name, '')), ' ', 1) AS first_name, coalesce(n.nights, 0)::int AS nights
        FROM venue_regular_optins r
        JOIN "User" u ON u.id = r.user_id
        LEFT JOIN profiles p ON p.id = r.user_id
        LEFT JOIN (${nightsSql(
          venue,
          from,
          to,
          Prisma.sql`SELECT user_id FROM venue_regular_optins WHERE venue_id = ${venueId}::uuid AND org_id = ${venue.owner_org_id}::uuid`
        )}) n ON n.user_id = r.user_id
       WHERE r.venue_id = ${venueId}::uuid
         AND r.org_id = ${venue.owner_org_id}::uuid
         AND u."deletedAt" IS NULL
         AND u.suspended_at IS NULL
       ORDER BY nights DESC, first_name
       LIMIT ${KNOWN_SHOWN}`,
  ])

  const boundaries = first ? weekBoundaries(venue.timezone, venue.day_reset_hour, first.created_at, now) : []
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
      reached: audienceBand(o.audience_size),
    })),
    totals: publishedTotals(boundaries, await histories(venueId, venue.owner_org_id, boundaries)),
    known: known.map((k) => ({ firstName: viewer.role === "app_admin" ? k.first_name || "Someone" : null, nights: k.nights })),
  }
}
