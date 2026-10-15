import "server-only"

import { ageFrom, isAdult } from "../age"
import { db } from "../db"
import { violatedConstraint } from "../prisma-errors"
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
/** How often a pass on screen re-marks itself as on screen. The door looks back three minutes. */
const PASS_SEEN_EVERY_MS = 60 * 1000

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

  // On screen now: the door matches a typed code only against passes being
  // shown. Written at most once a minute: the screen asks every few seconds (L5).
  await db.venue_offer_sends.updateMany({
    where: { id: send.id, OR: [{ pass_seen_at: null }, { pass_seen_at: { lt: new Date(now.getTime() - PASS_SEEN_EVERY_MS) } }] },
    data: { pass_seen_at: now },
  })
  return { ...shape(send, state), pass: currentPass(send.id, now) }
}

export interface RegularPrefs {
  /** "Let this venue know I'm a regular": an explicit yes to its current owner, revocable. */
  known: boolean
  /** No offers from this venue (kept across a change of owner). */
  offersMuted: boolean
  /** Who would see it: the organisation that runs the venue on Blendn now; null while nobody does. */
  ownerName: string | null
}

async function venueAndOwner(venueId: string) {
  return db.venues.findFirst({
    where: { id: venueId, deleted_at: null },
    select: { id: true, owner_org_id: true, owner_org: { select: { display_name: true } } },
  })
}

/** The caller's two choices about a venue, or null for no such (live) venue. */
export async function regularPrefs(userId: string, venueId: string): Promise<RegularPrefs | null> {
  const venue = await venueAndOwner(venueId)
  if (!venue) return null
  const [known, muted] = await Promise.all([
    // A yes to an earlier owner is not a yes to this one.
    venue.owner_org_id
      ? db.venue_regular_optins.findUnique({
          where: { venue_id_user_id_org_id: { venue_id: venueId, user_id: userId, org_id: venue.owner_org_id } },
          select: { user_id: true },
        })
      : null,
    db.venue_offer_mutes.findUnique({ where: { venue_id_user_id: { venue_id: venueId, user_id: userId } }, select: { user_id: true } }),
  ])
  return { known: known !== null, offersMuted: muted !== null, ownerName: venue.owner_org?.display_name ?? null }
}

export type PrefsRefusal = "not_found" | "unclaimed" | "not_adult"

/**
 * Change the caller's choices about a venue.
 *
 * Saying yes needs somebody to tell — a claimed venue — and an adult: the
 * venue learns a person's first name, and it may be a bar. The yes is given to
 * the organisation that runs the venue now. No yes, no, mute or unmute is
 * written to audit_logs (review H1): those rows are read by organisations, and
 * a person's own choice about a place is nobody's record but theirs — the
 * opt-in row's `created_at` is the proof of consent, and a no deletes it.
 */
export async function setRegularPrefs(
  userId: string,
  venueId: string,
  change: Partial<Pick<RegularPrefs, "known" | "offersMuted">>
): Promise<{ prefs: RegularPrefs } | { refusal: PrefsRefusal }> {
  const venue = await venueAndOwner(venueId)
  if (!venue) return { refusal: "not_found" }
  if (change.known === true) {
    if (!venue.owner_org_id) return { refusal: "unclaimed" }
    const profile = await db.profiles.findUnique({ where: { id: userId }, select: { age: true, date_of_birth: true } })
    if (!isAdult(ageFrom(profile))) return { refusal: "not_adult" }
  }

  const key = { venue_id: venueId, user_id: userId }
  if (change.known === true && venue.owner_org_id) {
    await db.venue_regular_optins.createMany({ data: [{ ...key, org_id: venue.owner_org_id }], skipDuplicates: true })
  } else if (change.known === false) {
    // Every yes this person gave here, to whichever owner.
    await db.venue_regular_optins.deleteMany({ where: key })
  }
  if (change.offersMuted === true) await db.venue_offer_mutes.createMany({ data: [key], skipDuplicates: true })
  else if (change.offersMuted === false) await db.venue_offer_mutes.deleteMany({ where: key })

  const prefs = await regularPrefs(userId, venueId)
  return { prefs: prefs ?? { known: false, offersMuted: false, ownerName: null } }
}

export interface OfferSettings {
  /** "Offers from places": the one switch for every venue (review M6). On unless turned off; off, no offer reaches them. */
  enabled: boolean
  /** Offer pushes (SCRUM-628): off until they say yes in the app. Off, offers still arrive, with no push. */
  pushes: boolean
}

const settingsSelect = { offers_from_places: true, offer_push_consent_at: true } as const

export async function offerSettings(userId: string): Promise<OfferSettings> {
  const profile = await db.profiles.findUnique({ where: { id: userId }, select: settingsSelect })
  return { enabled: profile?.offers_from_places ?? true, pushes: Boolean(profile?.offer_push_consent_at) }
}

/**
 * Changes what it is given. A yes to pushes is kept with when it was first
 * given — a second yes (a retry, a double tap) is the same yes; a no clears it.
 */
export async function setOfferSettings(userId: string, change: Partial<OfferSettings>, now: Date = new Date()): Promise<OfferSettings> {
  const firstYes = change.pushes
    ? (await db.profiles.findUnique({ where: { id: userId }, select: { offer_push_consent_at: true } }))?.offer_push_consent_at
    : null
  const profile = await db.profiles.update({
    where: { id: userId },
    data: {
      ...(change.enabled !== undefined && { offers_from_places: change.enabled }),
      ...(change.pushes !== undefined && { offer_push_consent_at: change.pushes ? (firstYes ?? now) : null }),
    },
    select: settingsSelect,
  })
  return { enabled: profile.offers_from_places, pushes: profile.offer_push_consent_at !== null }
}

export type ReportOutcome = "filed" | "already" | "not_found"

/**
 * "Report this offer" (review M5): into the reports queue every other report
 * goes to, as `message_type 'venue_offer'`, with the words as they read. Only
 * someone it was sent to can report it; one pending report per person per
 * offer (a partial unique in the migration).
 */
export async function reportOffer(userId: string, offerId: string, reason: string, description: string | null): Promise<ReportOutcome> {
  const send = await db.venue_offer_sends.findUnique({
    where: { offer_id_user_id: { offer_id: offerId, user_id: userId } },
    select: { offer: { select: { text: true } } },
  })
  if (!send) return "not_found"
  try {
    await db.message_reports.create({
      data: { reporter_id: userId, message_id: offerId, message_type: "venue_offer", reason: reason, description: description, excerpt: send.offer.text },
    })
    return "filed"
  } catch (error) {
    if (violatedConstraint(error, "message_reports_one_pending_offer_report")) return "already"
    throw error
  }
}
