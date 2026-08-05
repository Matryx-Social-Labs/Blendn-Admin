"use client"

import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts"
import type { ReactNode } from "react"

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart"
import { barWidth } from "@/lib/dashboard-view"
import { cn } from "@/lib/utils"

/**
 * Dashboard charts. Honest by construction, which here means three specific
 * rules the previous dashboard broke:
 *
 *   1. Axes start at zero. A truncated axis turns a 3% move into a cliff.
 *   2. Zero draws as zero. The old funnel floored every bar at 10% width, so a
 *      stage nobody reached looked like it had a tenth of the traffic.
 *   3. Empty says what will fill it, rather than rendering an empty grid that
 *      looks like a broken chart.
 */

function ChartFrame({
  title,
  hint,
  children,
  empty,
  emptyText,
}: {
  title: string
  hint?: string
  children: ReactNode
  empty?: boolean
  emptyText: string
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-bold">{title}</h3>
        {hint ? <span className="text-[0.75rem] text-faint-foreground">{hint}</span> : null}
      </div>
      <div className="relative">
        <div className={cn(empty && "opacity-30")}>{children}</div>
        {empty ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="max-w-[36ch] rounded-lg border border-border bg-card px-3 py-1.5 text-center text-[0.8125rem] text-muted-foreground">
              {emptyText}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

export type PacingPoint = { daysOut: number; cumulative: number }

/**
 * Cumulative RSVPs against days-to-event, with the capacity line drawn in.
 *
 * This is the organiser's primary chart and the single question the dashboard
 * previously could not answer: is the next event on track. The shape matters
 * more than the endpoint — a curve that flattened a week out is a different
 * problem from one that never started.
 *
 * x is inverted (21 days out on the left, event day on the right) so the line
 * reads left-to-right as time moving forward.
 */
export function PacingChart({
  points,
  capacity,
  windowDays = 21,
  empty,
}: {
  points: PacingPoint[]
  capacity: number | null
  windowDays?: number
  empty?: boolean
}) {
  const data = points.map((p) => ({ ...p, x: windowDays - p.daysOut }))
  const peak = Math.max(capacity ?? 0, ...points.map((p) => p.cumulative), 10)

  return (
    <ChartFrame
      title="RSVP pacing"
      hint={capacity ? `capacity ${capacity}` : "no capacity set"}
      empty={empty}
      emptyText="RSVPs plot here as they arrive — publish the event to start the curve."
    >
      <ChartContainer
        config={{ cumulative: { label: "RSVPs", color: "var(--chart-1)" } }}
        className="h-[200px] w-full"
      >
        <LineChart data={data} margin={{ left: 4, right: 12, top: 8 }}>
          <defs>
            <linearGradient id="pacing-brand" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#F05423" />
              <stop offset="100%" stopColor="#8F49AA" />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis
            dataKey="x"
            type="number"
            domain={[0, windowDays]}
            ticks={[0, Math.round(windowDays / 2), windowDays]}
            tickFormatter={(v: number) =>
              v === windowDays ? "event day" : `−${windowDays - v}d`
            }
            tickLine={false}
            axisLine={false}
            tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
          />
          <YAxis
            // Explicitly 0-based: recharts would otherwise pick a flattering floor.
            domain={[0, Math.ceil(peak * 1.05)]}
            tickLine={false}
            axisLine={false}
            width={32}
            tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
          />
          {capacity ? (
            <ReferenceLine
              y={capacity}
              stroke="var(--chart-3)"
              strokeDasharray="4 4"
              label={{
                value: "capacity",
                position: "insideTopRight",
                fill: "var(--chart-3)",
                fontSize: 11,
              }}
            />
          ) : null}
          <ChartTooltip
            content={
              <ChartTooltipContent
                className="rounded-xl border-border bg-card"
                labelFormatter={(_, payload) => {
                  const d = payload?.[0]?.payload as { daysOut?: number } | undefined
                  return d?.daysOut === 0 ? "Event day" : `${d?.daysOut}d before`
                }}
              />
            }
          />
          <Line
            dataKey="cumulative"
            type="monotone"
            stroke="url(#pacing-brand)"
            strokeWidth={2.5}
            dot={false}
            activeDot={{ r: 4, fill: "var(--chart-1)" }}
          />
        </LineChart>
      </ChartContainer>
    </ChartFrame>
  )
}

/* -------------------------------------------------------------------------- */

export type FunnelStage = { label: string; value: number; detail?: string }

/**
 * Horizontal funnel. Deliberately not a chart library component — a stage that
 * nobody reached must draw at zero width, and every funnel widget I know of
 * either floors it or refuses to render it.
 */
export function Funnel({
  stages,
  title = "Activation funnel",
  hint = "all time",
  empty,
}: {
  stages: FunnelStage[]
  title?: string
  hint?: string
  empty?: boolean
}) {
  const max = Math.max(...stages.map((s) => s.value), 1)

  return (
    <ChartFrame
      title={title}
      hint={hint}
      empty={empty}
      emptyText="Fills as people sign up, onboard, and check in to events."
    >
      <div className="flex flex-col gap-2">
        {stages.map((stage, index) => {
          const previous = index === 0 ? null : stages[index - 1].value
          const conversion =
            previous && previous > 0 ? Math.round((stage.value / previous) * 100) : null
          return (
            <div key={stage.label} className="flex items-center gap-2.5">
              <span className="w-24 shrink-0 text-right text-[0.75rem] text-muted-foreground">
                {stage.label}
              </span>
              <div className="h-5 flex-1 overflow-hidden rounded bg-surface-raised">
                <div
                  className="h-full rounded bg-chart-1"
                  style={{ width: `${barWidth(stage.value, max)}%` }}
                />
              </div>
              <span className="w-10 text-right text-[0.8125rem] font-bold tabular-nums">
                {stage.value}
              </span>
              <span className="w-12 text-right text-[0.75rem] text-faint-foreground tabular-nums">
                {conversion === null ? "" : `${conversion}%`}
              </span>
            </div>
          )
        })}
      </div>
    </ChartFrame>
  )
}

/* -------------------------------------------------------------------------- */

export type TrendSeries = { key: string; label: string; color: string }

/**
 * Multi-series area trend on a 0-based axis.
 *
 * The admin case plots signups against active users deliberately: the gap
 * between the two lines is the vanity, and a single signups line hides it.
 */
export function TrendArea({
  data,
  series,
  title,
  hint,
  empty,
}: {
  data: Array<Record<string, string | number>>
  series: TrendSeries[]
  title: string
  hint?: string
  empty?: boolean
}) {
  return (
    <ChartFrame
      title={title}
      hint={hint}
      empty={empty}
      emptyText="Plots as accounts and activity accrue."
    >
      <ChartContainer
        config={Object.fromEntries(series.map((s) => [s.key, { label: s.label, color: s.color }]))}
        className="h-[200px] w-full"
      >
        <AreaChart data={data} margin={{ left: 4, right: 12, top: 8 }}>
          <defs>
            {series.map((s) => (
              <linearGradient key={s.key} id={`trend-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={s.color} stopOpacity={0.3} />
                <stop offset="95%" stopColor={s.color} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
          />
          <YAxis
            domain={[0, "auto"]}
            allowDecimals={false}
            tickLine={false}
            axisLine={false}
            width={32}
            tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
          />
          <ChartTooltip
            content={<ChartTooltipContent className="rounded-xl border-border bg-card" />}
          />
          {series.map((s) => (
            <Area
              key={s.key}
              dataKey={s.key}
              type="monotone"
              stroke={s.color}
              strokeWidth={2}
              fill={`url(#trend-${s.key})`}
              dot={false}
            />
          ))}
        </AreaChart>
      </ChartContainer>
      <div className="flex gap-3.5 text-[0.75rem] text-muted-foreground">
        {series.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <i className="inline-block size-2 rounded-[2px]" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
    </ChartFrame>
  )
}

/* -------------------------------------------------------------------------- */

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const
const SLOTS = ["morn", "aft", "eve", "late"] as const

/**
 * Day × time-slot utilisation for a venue.
 *
 * A heatmap rather than a bar chart because the venue owner's question is
 * two-dimensional — "when am I busy" means both which night and which part of
 * it, and that pattern is what they sell against.
 */
export function UtilHeatmap({
  /** counts[dayIndex][slotIndex], Monday-first. */
  counts,
  empty,
}: {
  counts: number[][]
  empty?: boolean
}) {
  const max = Math.max(1, ...counts.flat())

  return (
    <ChartFrame
      title="Utilisation by day and time"
      hint="last 8 weeks"
      empty={empty}
      emptyText="Fills as events are hosted — shows your peak days and times."
    >
      <div className="grid grid-cols-[38px_repeat(7,1fr)] gap-1 text-[0.6875rem] text-muted-foreground">
        <span />
        {DAYS.map((d) => (
          <span key={d} className="text-center">
            {d}
          </span>
        ))}
        {SLOTS.map((slot, si) => (
          <div key={slot} className="contents">
            <span className="self-center">{slot}</span>
            {DAYS.map((day, di) => {
              const value = counts[di]?.[si] ?? 0
              return (
                <div
                  key={day}
                  title={`${day} ${slot}: ${value} event${value === 1 ? "" : "s"}`}
                  className="h-6 rounded"
                  style={{
                    background:
                      value === 0
                        ? "var(--surface-raised)"
                        : `oklch(0.652 0.2 36.7 / ${(0.2 + 0.8 * (value / max)).toFixed(2)})`,
                  }}
                />
              )
            })}
          </div>
        ))}
      </div>
    </ChartFrame>
  )
}

/* -------------------------------------------------------------------------- */

export type ArrivalPoint = { label: string; checkedIn: number; checkedOut: number }

/**
 * Live arrivals: cumulative check-ins and check-outs against wall-clock, with
 * the capacity line and a "now" marker.
 *
 * Two series rather than one net figure, because they say different things —
 * a flat check-in line with a rising check-out line is people leaving, and a
 * single "inside now" number hides that entirely until it is too late.
 */
export function ArrivalCurve({
  data,
  capacity,
  doorsLabel,
  endLabel,
  empty,
}: {
  data: ArrivalPoint[]
  capacity: number | null
  doorsLabel: string
  endLabel: string
  empty?: boolean
}) {
  return (
    <ChartFrame
      title="Arrivals"
      hint={capacity ? `doors ${doorsLabel} · capacity ${capacity} · ends ${endLabel}` : `doors ${doorsLabel}`}
      empty={empty}
      emptyText="Plots from doors open — cumulative GPS check-ins against capacity, check-outs alongside."
    >
      <ChartContainer
        config={{
          checkedIn: { label: "checked in", color: "var(--chart-1)" },
          checkedOut: { label: "checked out", color: "var(--muted-foreground)" },
        }}
        className="h-[200px] w-full"
      >
        <LineChart data={data} margin={{ left: 4, right: 12, top: 8 }}>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
          />
          <YAxis
            domain={[0, "auto"]}
            allowDecimals={false}
            tickLine={false}
            axisLine={false}
            width={32}
            tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
          />
          {capacity ? (
            <ReferenceLine
              y={capacity}
              stroke="var(--chart-3)"
              strokeDasharray="4 4"
              label={{
                value: "capacity",
                position: "insideTopRight",
                fill: "var(--chart-3)",
                fontSize: 11,
              }}
            />
          ) : null}
          <ChartTooltip
            content={<ChartTooltipContent className="rounded-xl border-border bg-card" />}
          />
          <Line dataKey="checkedIn" type="monotone" stroke="var(--chart-1)" strokeWidth={2.5} dot={false} />
          <Line
            dataKey="checkedOut"
            type="monotone"
            stroke="var(--muted-foreground)"
            strokeWidth={1.5}
            strokeDasharray="3 3"
            dot={false}
          />
        </LineChart>
      </ChartContainer>
    </ChartFrame>
  )
}

/* -------------------------------------------------------------------------- */

/**
 * Message counts by issue category.
 *
 * `safety_conduct` always draws destructive and is annotated, because it
 * escalates regardless of how few there are — one is enough.
 */
export function CategoryBars({
  data,
  title = "By category",
  hint,
  empty,
  emptyText = "Categorised messages count up here.",
}: {
  data: Array<{ category: string; count: number }>
  title?: string
  hint?: string
  empty?: boolean
  emptyText?: string
}) {
  const max = Math.max(1, ...data.map((d) => d.count))
  return (
    <ChartFrame title={title} hint={hint} empty={empty} emptyText={emptyText}>
      <div className="flex flex-col gap-1.5">
        {data.map((d) => {
          const safety = d.category === "safety_conduct"
          return (
            <div key={d.category} className="flex items-center gap-2.5">
              <span
                className={cn(
                  "w-24 shrink-0 text-right text-[0.75rem]",
                  safety ? "font-medium text-destructive" : "text-muted-foreground"
                )}
              >
                {d.category.replace(/_/g, " ")}
              </span>
              <div className="h-4 flex-1 overflow-hidden rounded bg-surface-raised">
                <div
                  className={cn("h-full rounded", safety ? "bg-destructive" : "bg-chart-1")}
                  style={{ width: `${barWidth(d.count, max)}%` }}
                />
              </div>
              <span className="w-16 text-[0.75rem] tabular-nums">
                <b className="font-bold">{d.count}</b>
                {safety ? <span className="text-destructive"> → mod</span> : null}
              </span>
            </div>
          )
        })}
      </div>
    </ChartFrame>
  )
}
