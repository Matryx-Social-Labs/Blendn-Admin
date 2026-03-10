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
  performance: {
    title: string
    description: string
    rows: DashboardPerformanceRow[]
  }
  exports: DashboardExportBundle[]
}
