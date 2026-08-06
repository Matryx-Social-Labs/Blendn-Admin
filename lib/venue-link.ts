import { db } from "@/lib/db"
import type { venue_link_status } from "@prisma/client"

/**
 * Resolving an event's link to a listed venue.
 *
 * Not in `lib/venue-actions.ts` deliberately: that file is `"use server"`, so
 * everything it exports becomes an endpoint any signed-in caller can invoke.
 * This is route-internal.
 *
 * The rule that matters: **`venue_link_status` is derived here, never taken
 * from the request.** A client that could send `confirmed` would link its event
 * to someone else's venue and mark it settled in one call, skipping the owner's
 * dispute path entirely. Organisers say *which* venue; the platform says what
 * the link means.
 */
export interface VenueLink {
  venue_id: string | null
  venue_link_status: venue_link_status | null
}

/** Nothing linked — free-text venue, which is the common case. */
export const NO_VENUE_LINK: VenueLink = { venue_id: null, venue_link_status: null }

export async function resolveVenueLink(
  venueId: unknown,
  /** The link already on the event, so a re-save does not undo a confirmation. */
  existing?: VenueLink | null
): Promise<VenueLink> {
  if (typeof venueId !== "string" || venueId.trim() === "") return NO_VENUE_LINK

  const venue = await db.venues.findUnique({
    where: { id: venueId, deleted_at: null },
    select: { id: true },
  })
  // A bad id is dropped rather than raised: the venue name still saves, and
  // failing the whole event save over a stale link would lose the organiser's
  // work for something they cannot see or fix.
  if (!venue) return NO_VENUE_LINK

  // Re-saving an event whose link a venue owner already confirmed or disputed
  // must not quietly reset it to auto_linked.
  if (existing?.venue_id === venue.id && existing.venue_link_status) {
    return { venue_id: venue.id, venue_link_status: existing.venue_link_status }
  }

  return { venue_id: venue.id, venue_link_status: "auto_linked" }
}
