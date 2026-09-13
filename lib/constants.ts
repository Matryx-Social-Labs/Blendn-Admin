// ── Rate Limiting ──────────────────────────────────────
export const RATE_LIMIT_MAX_ENTRIES = 10_000

export const RATE_LIMIT_WINDOW = {
  SIGNIN: 15 * 60 * 1000, // 15 minutes
  SIGNUP: 60 * 60 * 1000, // 1 hour
  GOOGLE_AUTH: 15 * 60 * 1000, // 15 minutes
  REFRESH: 15 * 60 * 1000, // 15 minutes
  BATCH: 60 * 1000, // 1 minute
  CHECKIN: 10 * 60 * 1000, // 10 minutes
  DASHBOARD_SIGNIN: 15 * 60 * 1000, // 15 minutes
  ORGANISER_BROADCAST: 60 * 1000, // 1 minute
  PRIVATE_MESSAGE: 60 * 1000, // 1 minute
} as const

export const RATE_LIMIT_MAX_REQUESTS = {
  SIGNIN: 5,
  SIGNUP: 3,
  GOOGLE_AUTH: 10,
  REFRESH: 20,
  BATCH: 30,
  CHECKIN: 10,
  DASHBOARD_SIGNIN: 5,
  // Announcements and sponsored messages broadcast to every attendee.
  ORGANISER_BROADCAST: 10,
  PRIVATE_MESSAGE: 30,
} as const

// ── Caching ───────────────────────────────────────────
export const EVENTS_CACHE_TTL_MS = 30 * 1000 // 30 seconds
export const EVENTS_CACHE_MAX_SIZE = 100

// ── Pagination ────────────────────────────────────────
export const PAGINATION = {
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,
  DEFAULT_CHAT_LIMIT: 50,
} as const

/**
 * How many venue records the admin index fetches at once.
 *
 * It fetched every venue in the database and rendered every row with no search
 * and no pagination — 395 rows and a 15,812px document on the local seed alone,
 * with two correlated counts per row.
 *
 * Here rather than beside the query, because that query lives in a
 * `"use server"` module, which may only export async functions. An
 * `export const` there is a build error invisible to `tsc` and to the whole
 * unit suite; only `next build` sees it. This is the second time.
 */
export const VENUE_INDEX_PAGE = 200

/**
 * How many structured interests one person may hold.
 *
 * An abuse ceiling, not a UI preference. Ranking sums IDF weights over shared
 * interests, and IDF damps *a category many people hold* — it does nothing
 * about *one person holding many categories*. Without a cap, ticking all 67
 * leaves shares an interest with everybody at full rarity weight and puts you
 * top of every list in the room; the damping only arrives once enough people
 * copy you, so the first one to try it is rewarded.
 *
 * The app shows the same number (`components/InterestPicker.tsx`), which until
 * now was the only thing enforcing it.
 */
/**
 * The check-in radius a new event's form starts at, in metres.
 *
 * Three files hardcoded `100` — the create form's default, the editor's
 * rehydrate fallback, and the location section's display fallback — while
 * `events.check_in_radius` carries a database default of **30**. Two numbers
 * for one field, and the register counted them as three conflicting defaults.
 *
 * The client trio is what an organiser actually meets, so it is consolidated
 * here rather than aligned downward: the register's own conclusion about
 * curated pins applies to every event, in that *too tight is the more
 * expensive error* — a fence that refuses somebody standing in the right place
 * costs more than one that admits the pavement.
 *
 * **The column default is deliberately left at 30 rather than migrated.** It is
 * reachable only by a caller that omits the field entirely, since both write
 * paths spread it conditionally and the form always sends a value; changing a
 * production column default to fix a value nearly nothing reads would be a
 * migration bought for a comment. This is that comment.
 *
 * Mostly vestigial either way: `geofence` supersedes this column, and where a
 * fence exists the form derives the radius from it (`extent + buffer`) rather
 * than using any default at all.
 */
export const DEFAULT_CHECK_IN_RADIUS_M = 100

export const MAX_INTERESTS = 10

// ── Check-in ──────────────────────────────────────────
export const CHECKIN = {
  DEFAULT_RADIUS_METERS: 30,
  MAX_GPS_ACCURACY_METERS: 150,
} as const

// ── Uploads ───────────────────────────────────────────
export const UPLOAD = {
  PRESIGNED_URL_EXPIRY_SECONDS: 900, // 15 minutes
  MAX_FILENAME_LENGTH: 255,
} as const

// ── Auth ──────────────────────────────────────────────
export const AUTH = {
  BCRYPT_ROUNDS: 12,
  ACCESS_TOKEN_EXPIRY: "15m",
  REFRESH_TOKEN_EXPIRY_DAYS: 30,
} as const

// ── Batch Operations ──────────────────────────────────
export const BATCH = {
  MAX_EVENT_IDS: 50,
  DEFAULT_INTERESTED_PREVIEW_LIMIT: 3,
} as const

// ── Sponsorship ───────────────────────────────────────────
/**
 * The policy numbers for sponsored placement.
 *
 * Grouped here rather than written into the sentence that needs them, matching
 * how every other tunable in this file is handled. `MIN_REPORTABLE` in
 * particular is a privacy control with two readers — the poll results and the
 * sponsor report — and they must never disagree.
 */
export const SPONSORSHIP = {
  /**
   * Below this, a per-option breakdown or a sponsor-facing figure identifies
   * people rather than describing them.
   *
   * `docs/DESIGN_HANDOFF.md` guarantees small rooms are normal: check-in never
   * refuses, so capacity is a signal and not a door. In a room of six, "1 vote
   * · Leaving early" names that person to everyone still there.
   *
   * Suppression is not per-cell. Hiding one option while publishing the total
   * leaks it by subtraction, and hiding all but one leaves the survivor
   * recoverable — see `lib/room-audience.ts` for the full rule.
   */
  MIN_REPORTABLE: 5,
  /** A room people joined to talk to strangers is not an ad break. */
  MAX_PLACEMENTS_PER_EVENT: 3,
  /**
   * Across ALL sponsors combined, not per campaign. Three advertisers each
   * individually well-behaved at 30 minutes still fire something every ten, and
   * the attendee does not care that each one behaved.
   */
  ROOM_MIN_GAP_MINUTES: 20,
  /** The floor a single campaign may be set to. */
  MIN_INTERVAL_MINUTES: 20,
  MAX_IMAGE_BYTES: 5 * 1024 * 1024,
  MAX_VIDEO_BYTES: 100 * 1024 * 1024,
  /** Consecutive send failures before a campaign deactivates itself. */
  FAILURE_LIMIT: 3,
} as const

/**
 * The pre-event board.
 *
 * The two caps below bound different abuses and are deliberately different
 * numbers: the first bounds a spray, the second bounds persistence. Somebody
 * can be under the first all evening by waiting for answers, and the second is
 * what stops them working through the whole board a week at a time.
 *
 * Here rather than inline because they are product decisions somebody will
 * want to argue with, and a number buried in a route is a number nobody
 * revisits.
 */
export const BOARD = {
  /**
   * Unanswered requests one person may have out at once.
   *
   * Five is enough to ask everybody plausibly worth asking at one event and
   * few enough that a spray is obvious. It clears as people answer, so an
   * active user is never blocked by their own patience.
   */
  MAX_OUTSTANDING_REQUESTS: 5,
  /**
   * Requests sent per rolling week, across every board.
   *
   * The outstanding cap alone is defeatable by persistence: withdraw, re-send,
   * withdraw, re-send. This bounds the total regardless of how quickly they
   * are answered.
   */
  MAX_REQUESTS_PER_WEEK: 20,
  /** The window the weekly cap counts over. */
  REQUEST_WEEK_DAYS: 7,
  /** Longest a post may be. Long enough for a plan, short enough to scan. */
  MAX_POST_LENGTH: 500,
  /** Longest an ask may be. "Can I join?" needs no essay. */
  MAX_REQUEST_LENGTH: 300,
} as const
