export type DashboardRole = "app_admin" | "organizer" | "venue_owner"

export type DashboardTrendKey = "users" | "events" | "attendees" | "engagement"

export interface DashboardMetric {
  label: string
  value: string
  delta: string
  trend: "up" | "down" | "flat"
  detail: string
}

export interface DashboardTrendPoint {
  label: string
  date: string
  users: number
  events: number
  attendees: number
  engagement: number
}

export interface DashboardFunnelStage {
  label: string
  value: number
  detail: string
}

export interface DashboardSpotlightCard {
  title: string
  value: string
  description: string
}

export interface DashboardPerformanceRow {
  id: string
  name: string
  segment: string
  status: string
  city: string
  startAt: string
  attendees: number
  demand: number
  engagement: number
  rating: number | null
  capacity: number | null
}

/**
 * A published event that has not happened yet.
 *
 * Every other number on this dashboard is trailing. This is the only
 * forward-looking one, and it is the first thing a host actually asks: how is
 * the next event pacing, and do I need to do something about it.
 */
export interface DashboardUpcomingRow {
  id: string
  name: string
  startAt: string
  daysOut: number
  /** RSVPs of going or maybe — the people who have signalled intent. */
  committed: number
  capacity: number | null
  /** null when the event has no stated capacity, so there is nothing to fill. */
  fillPct: number | null
  city: string
}

/** One bar of the role-specific breakdown chart. */
export interface DashboardBreakdownBar {
  label: string
  value: number
  detail: string
  /** Set when the bar leads somewhere actionable, e.g. a moderation queue. */
  href?: string
}

export interface DashboardExportBundle {
  name: string
  filename: string
  columns: string[]
  rows: Array<Record<string, string | number | null>>
}

export interface DashboardReport {
  role: DashboardRole
  headline: string
  summary: string
  metrics: DashboardMetric[]
  trend: {
    title: string
    description: string
    points: DashboardTrendPoint[]
    defaultKey: DashboardTrendKey
  }
  funnel: {
    title: string
    description: string
    stages: DashboardFunnelStage[]
  }
  spotlights: DashboardSpotlightCard[]
  upcoming: {
    title: string
    description: string
    rows: DashboardUpcomingRow[]
    emptyMessage: string
  }
  breakdown: {
    title: string
    description: string
    bars: DashboardBreakdownBar[]
    emptyMessage: string
  }
  performance: {
    title: string
    description: string
    rows: DashboardPerformanceRow[]
  }
  exports: DashboardExportBundle[]
}
