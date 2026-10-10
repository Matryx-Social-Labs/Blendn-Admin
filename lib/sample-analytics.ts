import type { EventAnalytics, OrgAnalytics } from "./org-analytics"
import type { PreClaimHistory, VenueInsight } from "./venue-insights"

/**
 * What a locked Analytics screen shows behind its blur: an illustration,
 * written here, of no organisation at all (owner ruling 2026-10-01; plan v2
 * §9.1 fix 1; `Locked` in components/dashboard/kit.tsx).
 *
 * Invented titles, invented numbers, fixed dates. It imports nothing that
 * reads the database, and `__tests__/previews-use-sample-data.test.ts` holds
 * the preview components to importing only this (MN-G02). Every id starts
 * `SAMPLE_`, so a test can tell a sample payload from a real one.
 */

export const SAMPLE_MARKER = "SAMPLE_"

export const SAMPLE_ORG_ANALYTICS: OrgAnalytics = {
  range: "90d",
  backWithin90: { pct: 38, cohort: 120, cohorts: 3 },
  comparison: [
    { eventId: "SAMPLE_1", title: "Sample: Rooftop social", startsAt: "2026-01-24T14:30:00.000Z", going: 64, came: 51, turnUpPct: 80, firstTimePct: 41, medianStayMin: 104, rating: 4.4 },
    { eventId: "SAMPLE_2", title: "Sample: Board games night", startsAt: "2026-01-10T13:00:00.000Z", going: 40, came: 27, turnUpPct: 68, firstTimePct: 52, medianStayMin: 86, rating: 4.1 },
    { eventId: "SAMPLE_3", title: "Sample: Vinyl listening", startsAt: "2025-12-20T14:00:00.000Z", going: 52, came: 38, turnUpPct: 73, firstTimePct: 34, medianStayMin: 121, rating: 4.6 },
    { eventId: "SAMPLE_4", title: "Sample: Founders breakfast", startsAt: "2025-12-06T03:30:00.000Z", going: 30, came: 22, turnUpPct: 73, firstTimePct: null, medianStayMin: 58, rating: null },
  ],
  cohorts: [
    { month: "2026-01", people: 46, back: { d30: 30, d60: "open", d90: "open" } },
    { month: "2025-12", people: 38, back: { d30: 26, d60: 34, d90: "open" } },
    { month: "2025-11", people: 36, back: { d30: 22, d60: 31, d90: 39 } },
  ],
  pacing: {
    title: "Sample: Rooftop social",
    capacity: 80,
    windowDays: 14,
    basedOn: 5,
    points: [0, 2, 5, 7, 10, 14, 18, 21, 25, 30, 34, 39, 45, 52, 58].map((cumulative, i) => ({ daysOut: 14 - i, cumulative })),
    median: [0, 1, 3, 5, 7, 10, 13, 16, 19, 23, 27, 31, 36, 41, 47].map((cumulative, i) => ({ daysOut: 14 - i, cumulative })),
  },
}

export const SAMPLE_EVENT_ANALYTICS: EventAnalytics = {
  eventId: "SAMPLE_1",
  people: 51,
  stay: { p50Min: 104, quartiles: { p25Min: 62, p75Min: 141 }, leftEarlyPct: 22, softPct: 12 },
  arrivals: [
    { from: "2026-01-24T14:00:00.000Z", to: "2026-01-24T14:10:00.000Z", people: 6 },
    { from: "2026-01-24T14:10:00.000Z", to: "2026-01-24T14:20:00.000Z", people: 9 },
    { from: "2026-01-24T14:20:00.000Z", to: "2026-01-24T14:30:00.000Z", people: 14 },
    { from: "2026-01-24T14:30:00.000Z", to: "2026-01-24T14:40:00.000Z", people: 11 },
    { from: "2026-01-24T14:40:00.000Z", to: "2026-01-24T15:10:00.000Z", people: 11 },
  ],
  firstTimers: 21,
  returning: 30,
  funnel: { viewers: 212, viewersWhoRsvpd: 58, conversionPct: 27 },
}

/**
 * A venue's year under Venue Pro (step 17), for the locked panel a Listed
 * venue sees. Invented, like the rest of this file.
 */
export const SAMPLE_VENUE_INSIGHTS: VenueInsight = {
  window: "12m",
  from: "2025-02-01T00:00:00.000Z",
  to: "2026-02-01T00:30:00.000Z",
  people: [
    [0, 6, 18, 9],
    [0, 7, 22, 11],
    [0, 9, 31, 14],
    [5, 11, 44, 26],
    [8, 14, 63, 58],
    [21, 35, 71, 66],
    [26, 30, 38, 12],
  ],
  regulars: { visitors: 412, regulars: 118, oneTimers: 294, sharePct: 29 },
}

export const SAMPLE_PRE_CLAIM: PreClaimHistory = { nights: 37, people: 680, since: "2024-11" }

/** What the regulars & offers composer will report (step 12), for its placeholder. */
export const SAMPLE_VENUE_OFFERS = {
  offer: "Sample: a free pint with your second visit this month",
  audience: "Regulars · came 2+ nights in the last 60 days",
  sent: 96,
  opened: 71,
  redeemed: 23,
}
