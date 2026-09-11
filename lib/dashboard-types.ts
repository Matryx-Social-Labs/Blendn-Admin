// Type-only, so neither module's `db` import survives into a client bundle.
import type { AttentionQueue } from "@/lib/attention-queues"
import type { RefusalBreakdown } from "@/lib/check-in-refusals"

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
  /** The last event that ran, on the same window — the ghost under the live curve. */
  benchmark: { title: string; points: PacingPoint[] } | null
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
  /**
   * Every queue with something in it, and every queue without.
   *
   * Was `ModerationAttention` — flags only — which is how the strip came to
   * read "Moderation queue is clear" beside a sidebar showing `Claims 4` and
   * `Applications 7`. See `lib/attention-queues.ts`, which is now the single
   * source for this and for those badges.
   */
  attention: AttentionQueue[]
  /**
   * When the server computed all of this, ISO.
   *
   * The attention strip renders ages ("open 23h", "open 1 day") from a `now`,
   * and it lives inside a client component — so a `new Date()` taken during
   * hydration is a DIFFERENT now from the one the server rendered with. An item
   * sitting at 23h59m crosses the day boundary between the two and React
   * reports a hydration mismatch on a screen that was correct both times.
   *
   * Rare, and the kind of rare that only ever happens in production. One field
   * removes the class rather than narrowing the window.
   */
  generatedAt: string
  /**
   * Distinct people who opened the app in the last seven days, and which
   * signal produced that number.
   *
   * Rendered as the loop's hint rather than as its own tile: it is the only
   * honest liveness signal on the screen, and on its own it answered nothing.
   * Beside "113 signed up" it answers how much of that is real.
   *
   * `source` is displayed. It used to be distinct refresh-token holders
   * unconditionally — a "session proxy" by its own label — and it is now real
   * app-opens wherever `product_events` has any, falling back only while the
   * table is still filling. A number that can come from two sources has to say
   * which, or it is two numbers wearing one label.
   */
  activeThisWeek: { count: number; source: "app_opens" | "proxy" }
  /** Arrivals in the window. Rows, not people — see the panel's own note. */
  checkIns: number
  /** People turned away at a door in the same window. The other half of turn-up. */
  refusals: RefusalBreakdown
  /** Period-over-period change for arrivals, the one figure that carries one. */
  deltas: { checkIns: TileDelta }
  /** The window these figures cover. */
  rangeLabel: string
  publishingHosts: { publishing: number; total: number }
  /** Published and not yet ended. The forward-looking half of supply. */
  upcomingEvents: number
  /** Events we listed ourselves. Never host liquidity — see `hostSupply`. */
  curated: { published: number; unclaimed: number }
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

/**
 * The sponsor's home screen.
 *
 * There wasn't one. `getDashboardOverview` branched on `app_admin` and
 * `venue_owner` and fell through to `buildOrganizerOverview(userId)` — scoped
 * to `organizer_id = <the sponsor's own user id>`, which is never theirs. So a
 * sponsor's landing page was an organiser dashboard reading all zeros, for
 * every sponsor, permanently.
 *
 * The hole was in this union as much as in the branch: three members for four
 * roles, and nothing to make the fourth a type error.
 *
 * Deliberately thin. `getSponsorOverview` already assembles what this role
 * needs and `/dashboard/placements` already renders it well; the defect was
 * that the landing page never asked. This carries the same payload rather than
 * inventing a second set of sponsor numbers — two answers to "how is my
 * campaign doing" is the shape of bug this codebase keeps finding.
 */
export interface SponsorOverview {
  role: "sponsor"
  brandName: string | null
  next: {
    eventTitle: string
    startTime: string
    ready: boolean
    blocker: string | null
  } | null
  liveNow: number
  awaitingYou: number
  reach30d: number | null
  reach30dSuppressed: boolean
}

export type DashboardOverview =
  | OrganizerOverview
  | AdminOverview
  | VenueOverview
  | SponsorOverview

/**
 * One venue *record*, for the admin index.
 *
 * Deliberately not `VenueRow`, which is the venue owner's utilisation view —
 * nights per week, ratings, next booking. That answers "how is my building
 * doing"; this answers "what venues exist, who owns each, and which are
 * unclaimed", which is what `dashboard-nav.ts` has described all along while
 * pointing at a list of user accounts.
 */
export interface VenueRecordRow {
  id: string
  name: string
  city: string | null
  /** The owning organisation's name, or null when nobody has claimed it. */
  owner: string | null
  events: number
  /** Claims waiting on a decision. A venue can attract more than one. */
  pendingClaims: number
  status: string
  /**
   * `owner` as a filterable value.
   *
   * `DataTable` filters with `String(row[key]) === value`, so a filter keyed on
   * `owner` can only ever match a literal organisation name — an "Unclaimed"
   * option would be a control that selects nothing, which is the
   * ship-the-UI-without-the-logic anti-pattern the roadmap names explicitly.
   * Derived on the server so the control has something to match.
   */
  ownership: "claimed" | "unclaimed"
}
