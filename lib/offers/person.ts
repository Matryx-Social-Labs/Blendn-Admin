import "server-only"

import { ageFrom, isAdult } from "../age"
import { db } from "../db"
import { venueDayBounds } from "../venue-day"
import { currentPass } from "./pass-code"

/**
 * A person's own side of regulars and offers (step 12): the offers they were
 * sent, the door pass, and their two choices about a venue — to be known
 * there as a regular, and to hear no offers from it.
 *
 * Everything here is keyed on the caller's own id. Nothing here is ever
 * shown to a venue (`lib/offers/venue.ts` is the venue's side).
 */

/** live: the pass can be shown. used_tonight: another of this venue's passes was redeemed tonight. */
export type OfferState = "live" | "redeemed" | "used_tonight" | "ended"

export interface PersonOffer {
  /** The offer's id: the same for everyone it went to, and answered only for them. */
  id: string
  venue: { id: string; name: string }
  text: string
  sentAt: string
  endsAt: string
  state: OfferState
}

export interface OpenedOffer extends PersonOffer {
  /** The code on the pass now, and when it turns; only while `live`. */
  pass: { code: string; rotatesAt: string } | null
}

const sendSelect = {
  id: true,
  sent_at: true,
  redeemed_at: true,
  opened_at: true,
  offer: {
    select: {
      id: true,
      text: true,
      ends_at: true,
      org_id: true,
      venue: { select: { id: true, name: true, owner_org_id: true, deleted_at: true, timezone: true, day_reset_hour: true } },
    },
  },
} as const

type SendRow = {
  id: string
  sent_at: Date
  redeemed_at: Date | null
  offer: {
    id: string
    text: string
    ends_at: Date
    org_id: string
    venue: { id: string; name: string; owner_org_id: string | null; deleted_at: Date | null }
  }
}

/**
 * Over: its end has passed, the venue was retired, or it changed hands — a
 * new owner's staff do not honour the last owner's promises.
 */
function baseState(send: SendRow, now: Date): OfferState {
  if (send.redeemed_at) return "redeemed"
  const { offer } = send
  if (offer.ends_at <= now || offer.venue.deleted_at || offer.venue.owner_org_id !== offer.org_id) return "ended"
  return "live"
}

function shape(send: SendRow, state: OfferState): PersonOffer {
  return {
    id: send.offer.id,
    venue: { id: send.offer.venue.id, name: send.offer.venue.name },
    text: send.offer.text,
    sentAt: send.sent_at.toISOString(),
    endsAt: send.offer.ends_at.toISOString(),
    state,
  }
}

const MY_OFFERS_LIMIT = 50

/** The caller's offers, newest first. Reading the list opens nothing. */
export async function myOffers(userId: string, now: Date = new Date()): Promise<PersonOffer[]> {
  const sends = await db.venue_offer_sends.findMany({
    where: { user_id: userId },
    orderBy: { sent_at: "desc" },
    take: MY_OFFERS_LIMIT,
    select: sendSelect,
  })
  return sends.map((s) => shape(s, baseState(s, now)))
}

/** The venue's night as a DATE column holds it. */
const nightDate = (localDate: string) => new Date(`${localDate}T00:00:00Z`)

/**
 * Open one offer: the venue, its words, and — while it can be used — the pass.
 *
 * Opening is what the venue's "opened" counts, once. Null for an offer the
 * caller was not sent, so another person's offer and no offer read the same.
 */
export async function openOffer(userId: string, offerId: string, now: Date = new Date()): Promise<OpenedOffer | null> {
  const send = await db.venue_offer_sends.findUnique({
    where: { offer_id_user_id: { offer_id: offerId, user_id: userId } },
    select: sendSelect,
  })
  if (!send) return null
  if (!send.opened_at) {
    await db.venue_offer_sends.updateMany({ where: { id: send.id, opened_at: null }, data: { opened_at: now } })
  }

  let state = baseState(send, now)
  if (state === "live") {
    const { venue } = send.offer
    const tonight = venueDayBounds(venue.timezone, venue.day_reset_hour, now).localDate
    const used = await db.venue_offer_sends.findFirst({
      where: { venue_id: venue.id, user_id: userId, redeemed_night: nightDate(tonight) },
      select: { id: true },
    })
    if (used) state = "used_tonight"
  }
  if (state !== "live") return { ...shape(send, state), pass: null }

  // On screen now: the door matches a typed code only against passes being shown.
  await db.venue_offer_sends.update({ where: { id: send.id }, data: { pass_seen_at: now } })
  return { ...shape(send, state), pass: currentPass(send.id, now) }
}

export interface RegularPrefs {
  /** "Let this venue know I'm a regular": an explicit yes, revocable. */
  known: boolean
  /** No offers from this venue. */
  offersMuted: boolean
}

/** The caller's two choices about a venue, or null for no such (live) venue. */
export async function regularPrefs(userId: string, venueId: string): Promise<RegularPrefs | null> {
  const venue = await db.venues.findFirst({ where: { id: venueId, deleted_at: null }, select: { id: true } })
  if (!venue) return null
  const [known, muted] = await Promise.all([
    db.venue_regular_optins.findUnique({ where: { venue_id_user_id: { venue_id: venueId, user_id: userId } }, select: { user_id: true } }),
    db.venue_offer_mutes.findUnique({ where: { venue_id_user_id: { venue_id: venueId, user_id: userId } }, select: { user_id: true } }),
  ])
  return { known: known !== null, offersMuted: muted !== null }
}

export type PrefsRefusal = "not_found" | "unclaimed" | "not_adult"

/**
 * Change the caller's choices about a venue. Each change that happens is
 * audited in the same transaction, so there is never a yes without its record
 * (or a record of a yes that did not happen).
 *
 * Saying yes needs somebody to tell: a claimed venue. And an adult: the venue
 * learns a person's first name, and it may be a bar.
 */
export async function setRegularPrefs(
  userId: string,
  venueId: string,
  change: Partial<RegularPrefs>,
  ipAddress: string | null
): Promise<{ prefs: RegularPrefs } | { refusal: PrefsRefusal }> {
  const venue = await db.venues.findFirst({
    where: { id: venueId, deleted_at: null },
    select: { id: true, owner_org_id: true },
  })
  if (!venue) return { refusal: "not_found" }
  if (change.known === true) {
    if (!venue.owner_org_id) return { refusal: "unclaimed" }
    const profile = await db.profiles.findUnique({ where: { id: userId }, select: { age: true, date_of_birth: true } })
    if (!isAdult(ageFrom(profile))) return { refusal: "not_adult" }
  }

  const key = { venue_id: venueId, user_id: userId }
  await db.$transaction(async (tx) => {
    const audit = (action: string) =>
      tx.audit_logs.create({ data: { user_id: userId, action: action, resource: "venue", resource_id: venueId, ip_address: ipAddress } })
    if (change.known !== undefined) {
      const { count } = change.known
        ? await tx.venue_regular_optins.createMany({ data: [key], skipDuplicates: true })
        : await tx.venue_regular_optins.deleteMany({ where: key })
      if (count > 0) await audit(change.known ? "venue_regular.optin" : "venue_regular.optout")
    }
    if (change.offersMuted !== undefined) {
      const { count } = change.offersMuted
        ? await tx.venue_offer_mutes.createMany({ data: [key], skipDuplicates: true })
        : await tx.venue_offer_mutes.deleteMany({ where: key })
      if (count > 0) await audit(change.offersMuted ? "venue_offer.mute" : "venue_offer.unmute")
    }
  })
  const prefs = await regularPrefs(userId, venueId)
  return { prefs: prefs ?? { known: false, offersMuted: false } }
}
