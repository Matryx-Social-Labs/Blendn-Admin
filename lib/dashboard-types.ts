export type DashboardRole = "app_admin" | "organizer" | "venue_owner"

/* -------------------------------------------------------------------------- */
/* Shared                                                                      */
/* -------------------------------------------------------------------------- */

export interface EventRow {
  id: string
  name: string
  startAt: string
  city: string
  venue: string
  status: string
  going: number
  /** null when the event states no capacity — there is no target to fill. */
  fillPct: number | null
  /** null until the event has run. */
  turnUpPct: number | null
}

/** Cumulative RSVPs at a given number of days before the event starts. */
export interface PacingPoint {
  daysOut: number
  cumulative: number
}

/** Index 0 is one star, index 4 is five. */
export type RatingCounts = [number, number, number, number, number]

/* -------------------------------------------------------------------------- */
/* Organiser                                                                   */
/* -------------------------------------------------------------------------- */

export interface NextEvent {
  id: string
  title: string
  startAt: string
  venue: string
  city: string
  daysOut: number
  going: number
  maybe: number
  favourites: number
  capacity: number | null
  fillPct: number | null
  /**
   * Comparison against the previous event's curve at the same point. null when
   * there is no previous event to compare to — an invented benchmark is worse
   * than none.
   */
  pacingNote: string | null
}

export interface OrganizerOverview {
  role: "organizer"
  nextEvent: NextEvent | null
  pacing: PacingPoint[]
  pacingCapacity: number | null
  ratings: RatingCounts
  noShowRatePct: number | null
  noShowDelta: number | null
  repeatAttendees: number | null
  averageRating: number | null
  ratingCount: number
  chatToday: number
  events: EventRow[]
}

/* -------------------------------------------------------------------------- */
/* Admin                                                                       */
/* -------------------------------------------------------------------------- */

export interface ModerationAttention {
  pending: number
  /** Age of the oldest pending flag, in hours. The SLA is age, not count. */
  oldestHours: number | null
  highConfidence: number
  affectedRooms: number
}

export interface OrganiserSupplyRow {
  id: string
  name: string
  published: number
  drafts: number
  sharePct: number
  lastEventAt: string | null
}

export interface CityRow {
  city: string
  events: number
  rsvps: number
  favourites: number
}

export interface AdminOverview {
  role: "app_admin"
  attention: ModerationAttention
  users: number
  activeThisWeek: number
  publishedEvents: number
  checkIns: number
  publishingHosts: { publishing: number; total: number }
  growth: Array<{ label: string; signups: number; active: number }>
  funnel: Array<{ label: string; value: number }>
  supply: OrganiserSupplyRow[]
  cities: CityRow[]
}

/* -------------------------------------------------------------------------- */
/* Venue owner                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A venue, derived by grouping events on `events.venue_name`.
 *
 * There is no `venues` table — see docs/DASHBOARD_REDESIGN.md. Consequences
 * that show up in the UI: `capacity` is the largest capacity any event at this
 * venue declared (a proxy, not the room's real capacity), and two spellings of
 * the same room are two venues.
 */
export interface VenueRow {
  name: string
  eventsInWindow: number
  /** Events per week over the trailing 8 weeks. */
  nightsPerWeek: number
  averageRating: number | null
  ratings: RatingCounts
  nextBooking: { id: string; name: string; startAt: string; going: number } | null
  capacityProxy: number | null
  tone: "success" | "neutral" | "destructive"
  note: string
}

export interface VenueOverview {
  role: "venue_owner"
  venues: VenueRow[]
  /** counts[dayIndex][slotIndex], Monday-first, four slots per day. */
  utilisation: number[][]
  peakWindow: string | null
  turnUpRatePct: number | null
  eventsNext14d: number
}

export type DashboardOverview = OrganizerOverview | AdminOverview | VenueOverview
