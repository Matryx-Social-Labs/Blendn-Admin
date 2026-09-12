import type { PacingPoint } from "@/lib/dashboard-types"

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Cumulative committed RSVPs per day before the start, over a window.
 *
 * Pure, and shared by the organiser overview (the next event, with the last
 * event as a ghost) and the event page (this event). It lived inside
 * `app/dashboard/actions.ts`, which is a `"use server"` module and cannot
 * export a plain function.
 */
export function buildPacing(
  rsvps: Array<{ created_at: Date }>,
  startTime: Date,
  windowDays: number
): PacingPoint[] {
  const daysBefore = rsvps
    .map((r) => Math.max(0, Math.ceil((startTime.getTime() - r.created_at.getTime()) / DAY_MS)))
    .sort((a, b) => b - a)

  const points: PacingPoint[] = []
  for (let d = windowDays; d >= 0; d--) {
    points.push({ daysOut: d, cumulative: daysBefore.filter((x) => x >= d).length })
  }
  return points
}

/** The window the chart shows: two weeks past today, clamped to a week and two months. */
export function pacingWindowDays(daysOut: number) {
  return Math.max(7, Math.min(60, daysOut + 14))
}
