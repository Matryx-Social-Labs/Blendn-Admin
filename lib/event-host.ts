import type { event_kind } from "@prisma/client"

/**
 * Who to show as an event's host.
 *
 * ## Why this is not `organizer_id`
 *
 * When a claim is approved, `organizer_org_id` changes hands and
 * `organizer_id` **does not**. CLAUDE.md is explicit that `organizer_id`
 * records who *created* the row, and after a claim that is still true: the
 * platform created it. Rewriting it would destroy the only record that this
 * event was curated rather than filed, which is exactly the fact a later
 * dispute turns on.
 *
 * So "who created this" and "who to put on the card" are two questions, and
 * this answers the second. It is the same split as `organizer_id` versus
 * `organizer_org_id` for authorization — one is audit, one is live.
 *
 * ## The order
 *
 * The owning organisation first, because after a claim that is the answer and
 * it is the name an attendee would recognise. The creating user next, for
 * events that predate organisations. The platform last, which is the honest
 * answer for a curated event nobody has claimed — and saying so is better than
 * inventing a host, because the source link is right there and a reader can
 * check.
 */

/** The columns `eventHost` needs. Spread it; do not hand-pick. */
export const eventHostSelect = {
  kind: true,
  venue_name: true,
  curated_at: true,
  organizer_org: { select: { display_name: true } },
  organizer: { select: { name: true } },
} as const

export interface HostSource {
  kind?: event_kind
  venue_name?: string | null
  curated_at?: Date | null
  organizer_org?: { display_name: string | null } | null
  organizer?: { name: string | null } | null
}

/** What a curated event with no claimant says, rather than a person's name. */
export const PLATFORM_HOST = "Blendn"

export interface EventHost {
  name: string
  /**
   * True when this is the platform standing in, not a real organiser.
   *
   * The client needs to know: a curated listing should say where it came from
   * and offer the claim, and an organiser's event should not.
   */
  isPlatform: boolean
}

export function eventHost(event: HostSource): EventHost {
  /*
   * A venue day is the venue's room, and nobody hosts it (F2): it has no org,
   * and its creating user is the system user. The venue's name, copied onto
   * the row when the day was made — not the company that owns the venue
   * ("Indiranagar Hospitality Group" is not what anybody calls The Humming Tree).
   */
  if (event.kind === "venue_day") {
    return { name: event.venue_name?.trim() || PLATFORM_HOST, isPlatform: true }
  }

  const org = event.organizer_org?.display_name?.trim()
  if (org) return { name: org, isPlatform: false }

  /*
   * A curated event outranks the creating user, even though a user exists.
   *
   * The admin who ran the curation is not the host, and putting their name on
   * a public card would be both wrong and a small privacy leak -- it is the one
   * place a founder's real name would appear on an attendee-facing surface.
   */
  if (event.curated_at) return { name: PLATFORM_HOST, isPlatform: true }

  const person = event.organizer?.name?.trim()
  if (person) return { name: person, isPlatform: false }

  return { name: PLATFORM_HOST, isPlatform: true }
}
