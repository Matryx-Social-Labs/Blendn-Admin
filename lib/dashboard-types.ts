/**
 * Roles that get a dashboard shell.
 *
 * Kept in step with `user_role` by `__tests__/dashboard-view.test.ts`, which
 * exists because the nav gate drifted from `lib/rbac.ts` once already and a
 * whole role was locked out of a screen the authorization layer had always been
 * willing to serve.
 *
 * `attendee` is deliberately absent: attendees are mobile-only and
 * `middleware.ts` redirects them away.
 */
export type DashboardRole = "app_admin" | "organizer" | "venue_owner" | "sponsor"

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
  /**
   * Distinct people who looked for events here and found none.
   *
   * `city_demand` has been written on every miss since it was added and read by
   * nothing. This is the reader — and the row set is now the UNION of cities
   * with events and cities with demand, because the old list was built by
   * iterating events and so a city with demand and zero events could not appear
   * in it at all (C12). That is precisely the city the number exists for.
   */
  waiting: number
  /**
   * Enough people waiting, and nobody serving them.
   *
   * A decision rather than a number, because a metric with no decision rule is
   * a metric nobody acts on — which is how this table came to be written for
   * months and read never.
   */
  launchReady: boolean
}

/**
 * What a `MetricTile` needs to render a change.
 *
 * Both optional, and both genuinely absent sometimes: `delta` is omitted when
 * the baseline was zero (no honest percentage exists), and `hint` carries
 * "new" for the case where something appeared from nothing. See
 * `lib/metric-delta.ts`.
 */
export interface TileDelta {
  delta?: number
  hint?: string
}

export interface AdminOverview {
  role: "app_admin"
  attention: ModerationAttention
  users: number
  activeThisWeek: number
  publishedEvents: number
  checkIns: number
  /** Period-over-period change for the tiles that carry one. */
  deltas: {
    users: TileDelta
    publishedEvents: TileDelta
    checkIns: TileDelta
  }
  /** The window these figures cover, for the tiles' hint text. */
  rangeLabel: string
  publishingHosts: { publishing: number; total: number }
  /** Events we listed ourselves. Never host liquidity — see `hostSupply`. */
  curated: { published: number; unclaimed: number }
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
  /**
   * Last 90 days against the 90 before, in **percentage points**.
   *
   * Points rather than a percent change: 60% → 66% is "+6 points", and calling
   * that "+10%" invites reading it as 70%. Null when either window had no
   * committed RSVPs to measure against.
   */
  turnUpDelta: number | null
  eventsNext14d: number
}

export type DashboardOverview = OrganizerOverview | AdminOverview | VenueOverview
