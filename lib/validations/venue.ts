import { z } from "zod"

import { VENUE_TYPES } from "@/lib/venue-types"

/**
 * The query for `GET /api/mobile/venues` — the Hotspots feed.
 *
 * Deliberately the same vocabulary as `eventQuerySchema`: `city`, `lat`/`lon`,
 * `radius` and the pagination pair mean exactly what they mean there, because
 * Hotspots is the venue-shaped twin of The Pulse and one screen switches
 * between them. Two discovery feeds that take the same question in two
 * different dialects is how a shared city picker ends up with two code paths.
 *
 * What is **not** copied across: `radius` has no default here either — the same
 * mistake, a 10km box applied to anyone who merely sent coordinates, is what
 * blanked the events feed, and it would blank this one identically.
 */
export const venueQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),

  /** Matches name, address and city loosely — the same latitude `search` has on events. */
  search: z.string().max(200).optional(),

  /**
   * The browse scope, matched `equals` + case-insensitive against
   * `venues.city`, exactly as events are. Venues with no city are unreachable
   * this way, which matches how `/events/cities` builds the picker.
   */
  city: z.string().min(1).max(100).optional(),

  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
  /** Only bites when asked for. See the note above — no default, ever. */
  radius: z.coerce.number().min(0.1).max(100).optional(),

  venueType: z.enum(VENUE_TYPES).optional(),

  /*
   * `name` and `distance` only.
   *
   * The ordering Hotspots actually wants is "most going on here", and it is not
   * offered because it cannot be done honestly yet: Prisma's
   * `orderBy: { events: { _count } }` counts *every* related row, so it would
   * rank by an all-time total including cancelled drafts and events from two
   * years ago — a number that is not the one shown on the card. Doing it right
   * means either raw SQL or loading every venue to sort in memory.
   *
   * `upcomingEventCount` is on each item, so a caller can rank what it has been
   * given. That is not the same as ranking the whole set, and the difference
   * matters the moment there is more than one page — which is why this is
   * recorded here rather than papered over with an in-page sort.
   */
  sortBy: z.enum(["name", "distance"]).default("name"),
  sortOrder: z.enum(["asc", "desc"]).default("asc"),
})

export type VenueQueryInput = z.infer<typeof venueQuerySchema>
