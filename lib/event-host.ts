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
  organizer_org_id: true,
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
  /**
   * What the name is (Flow 5 C6, SCRUM-1095): an organisation, a venue's own room (a venue day), the platform
   * standing in, or — for an event with no organisation — the creating user. Room info's "Host" row is drawn only
   * for `org`, so a person is never labelled an event's host.
   */
  kind: "org" | "venue" | "platform" | "person"
}

export function eventHost(event: HostSource): EventHost {
  /*
   * A venue day is the venue's room, and nobody hosts it (F2): it has no org,
   * and its creating user is the system user. The venue's name, copied onto
   * the row when the day was made — not the company that owns the venue
   * ("Indiranagar Hospitality Group" is not what anybody calls The Humming Tree).
   */
  if (event.kind === "venue_day") {
    return { name: event.venue_name?.trim() || PLATFORM_HOST, isPlatform: true, kind: "venue" }
  }

  const org = event.organizer_org?.display_name?.trim()
  if (org) return { name: org, isPlatform: false, kind: "org" }

  /*
   * A curated event outranks the creating user, even though a user exists.
   *
   * The admin who ran the curation is not the host, and putting their name on
   * a public card would be both wrong and a small privacy leak -- it is the one
   * place a founder's real name would appear on an attendee-facing surface.
   */
  if (event.curated_at) return { name: PLATFORM_HOST, isPlatform: true, kind: "platform" }

  const person = event.organizer?.name?.trim()
  if (person) return { name: person, isPlatform: false, kind: "person" }

  return { name: PLATFORM_HOST, isPlatform: true, kind: "platform" }
}

/** What the app is sent as an event's `organizer`. */
export interface HostPayload {
  /** The organisation's id; null for every other kind. Never a user's. */
  id: string | null
  /** Null only for `person`: the creating user's name is theirs, and the app never shows it (SCRUM-1146). */
  name: string | null
  /** Always null. Kept so the response shape does not change; no host has a picture yet. */
  image: null
  kind: EventHost["kind"]
}

/**
 * The `organizer` of every mobile event read (SCRUM-1146): the org, never the creating user.
 *
 * `organizer_id` is who made the row; for a curated event that is the admin who ran the curation. Every route used to
 * send that user's id and picture beside the host's name, and the saved list sent the user row whole. This is the one
 * place the payload is built, so no route can send the creator again.
 */
export function hostPayload(event: HostSource & { organizer_org_id: string | null }): HostPayload {
  const host = eventHost(event)
  if (host.kind === "org") return { id: event.organizer_org_id, name: host.name, image: null, kind: "org" }
  return { id: null, name: host.kind === "person" ? null : host.name, image: null, kind: host.kind }
}
