import type { EventAnalytics, OrgAnalytics } from "./org-analytics"

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
  backWithin90: { pct: 38, cohort: 120 },
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
  stay: { p25Min: 62, p50Min: 104, p75Min: 141, leftEarlyPct: 22, softPct: 12 },
  arrivals: [6, 9, 14, 11, 8, 0, 5].map((people, i) => ({
    at: new Date(Date.UTC(2026, 0, 24, 14, i * 10)).toISOString(),
    people: people >= 5 ? people : null,
  })),
  firstTimers: 21,
  returning: 30,
  funnel: { viewers: 212, rsvps: 64, viewersWhoRsvpd: 58, conversionPct: 27 },
}
