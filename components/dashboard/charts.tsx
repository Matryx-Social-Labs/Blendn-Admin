"use client"

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts"
import { useMemo, useState, type ReactNode } from "react"
import { IconZoomReset } from "@tabler/icons-react"

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
  action,
}: {
  title: string
  hint?: string
  children: ReactNode
  empty?: boolean
  emptyText: string
  /** Chart-level control — reset zoom, export. Sits beside the hint. */
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        {/*
          `h2`, not `h3`.

          `site-header` owns the page's only `h1` and bodies start at `h2`, per
          the design system. Every chart panel rendered an `h3` — and on the
          admin overview those panels sit in the row *above* the `h2` tables, so
          the document outline read h1 → h3 → h3 → h2 → h2. A reader navigating
          by heading meets two subsections before their parent exists.

          They are siblings on screen; they are siblings in the outline now.
        */}
        <h2 className="text-sm font-bold">{title}</h2>
        <span className="flex items-baseline gap-3">
          {hint ? <span className="text-[0.75rem] text-faint-foreground">{hint}</span> : null}
          {action}
        </span>
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
            {/*
              The brand gradient, from the tokens rather than from two literals.

              `#8F49AA` is the purple at its *light-theme* lightness. The design
              system pins the dark theme's `--chart-3` higher (L 0.62 against
              0.532) precisely because "the brand purple at its true lightness
              does not carry against #0D0C0C" — and this app is dark-pinned, so
              the hardcoded pair was drawing the one value the doc says is too
              dark to read here.
            */}
            <linearGradient id="pacing-brand" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="var(--chart-1)" />
              <stop offset="100%" stopColor="var(--chart-3)" />
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
  title = "The loop",
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
      emptyText="Fills as people sign up, turn up, match, talk, and come back."
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
              {/*
                A stage nobody has reached is drawn at FULL width, in outline.

                Every other funnel in the world renders a zero stage as a sliver
                or as nothing, and `barWidth` correctly returns 0 for it — so
                three consecutive zeroes were three empty tracks the eye slid
                straight past. On this product that is the wrong reading twice
                over: `matched`, `conversed` and `came back` are the only three
                stages no competitor can measure, and they are the whole thesis.
                Nobody meeting anybody is the most important fact the dashboard
                can carry, and it was the quietest thing on the screen.

                Full-width and dashed makes the absence as wide as the 113 above
                it. It is a shape difference rather than a colour one, so it
                survives greyscale and colour-blindness without a legend.
              */}
              {stage.value === 0 ? (
                <div
                  className="h-5 flex-1 rounded border border-dashed border-border-strong"
                  aria-hidden
                />
              ) : (
                <div className="h-5 flex-1 overflow-hidden rounded bg-surface-raised">
                  <div
                    className="h-full rounded"
                    style={{
                      width: `${barWidth(stage.value, max)}%`,
                      background: stageFill(index, stages.length),
                    }}
                  />
                </div>
              )}
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

/**
 * Stages walk `--chart-1` to `--chart-3`, which `app/globals.css` documents as
 * the brand's orange-to-purple ramp sampled at three points.
 *
 * The screen was almost entirely `--chart-1` while 2 and 3 went unused, which
 * the design direction calls a one-note palette. Walking the ramp also carries
 * meaning for free: a stage's colour says how deep into the loop it is.
 *
 * **An earlier version of this gave stage 0 `--gradient-brand` itself, and the
 * comment above it claimed that did not collide with `HeroMetric`.** It did.
 * `DESIGN_SYSTEM.md` allows exactly one gradient element per screen, on the
 * grounds that a second one means the screen has two priorities and one of them
 * is wrong — and driving the page showed precisely that: the widest bar on the
 * screen competing with the hero beside it. The comment defended the bug, which
 * is worse than not having one.
 */
function stageFill(index: number, count: number): string {
  if (count < 2) return "var(--chart-1)"
  const step = Math.round((index / (count - 1)) * 2)
  return `var(--chart-${step + 1})`
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
  syncId,
}: {
  data: Array<Record<string, string | number>>
  series: TrendSeries[]
  title: string
  hint?: string
  empty?: boolean
  /** Charts sharing this id share a crosshair, so two stacked charts read together. */
  syncId?: string
}) {
  /*
   * Exploration, per design brief §1.3. This was a picture: hover-tooltip only,
   * no way to narrow the window, isolate a line, or get back out.
   *
   * Zoom is drag-to-select rather than a Brush strip — the brush costs 40px of
   * vertical space on every chart to serve a gesture people try on the plot
   * itself first.
   */
  const [hiddenSeries, setHiddenSeries] = useState<Set<string>>(() => new Set())
  const [dragFrom, setDragFrom] = useState<string | null>(null)
  const [dragTo, setDragTo] = useState<string | null>(null)
  const [zoom, setZoom] = useState<[number, number] | null>(null)

  const visible = useMemo(() => {
    if (!zoom) return data
    return data.slice(zoom[0], zoom[1] + 1)
  }, [data, zoom])

  function applyZoom() {
    if (dragFrom === null || dragTo === null || dragFrom === dragTo) {
      setDragFrom(null)
      setDragTo(null)
      return
    }
    const a = data.findIndex((d) => d.label === dragFrom)
    const b = data.findIndex((d) => d.label === dragTo)
    // Drag right-to-left is the same gesture; normalise rather than ignore it.
    const [lo, hi] = a <= b ? [a, b] : [b, a]
    // Two points is not a trend. Refusing a degenerate selection beats
    // rendering a chart with nothing in it.
    if (lo >= 0 && hi > lo) setZoom([lo, hi])
    setDragFrom(null)
    setDragTo(null)
  }

  const shown = series.filter((s) => !hiddenSeries.has(s.key))

  return (
    <ChartFrame
      title={title}
      hint={hint}
      empty={empty}
      emptyText="Plots as accounts and activity accrue."
      action={
        zoom ? (
          <button
            onClick={() => setZoom(null)}
            className="inline-flex items-center gap-1 text-[0.75rem] text-primary hover:underline"
          >
            <IconZoomReset className="size-3.5" /> Reset zoom
          </button>
        ) : null
      }
    >
      <ChartContainer
        config={Object.fromEntries(series.map((s) => [s.key, { label: s.label, color: s.color }]))}
        className="h-[200px] w-full select-none"
      >
        <AreaChart
          data={visible}
          margin={{ left: 4, right: 12, top: 8 }}
          syncId={syncId}
          onMouseDown={(e) => e?.activeLabel && setDragFrom(String(e.activeLabel))}
          onMouseMove={(e) => dragFrom && e?.activeLabel && setDragTo(String(e.activeLabel))}
          onMouseUp={applyZoom}
          // A drag that leaves the plot would otherwise stay armed and zoom on
          // the next unrelated click.
          onMouseLeave={() => {
            setDragFrom(null)
            setDragTo(null)
          }}
        >
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
          {/* `shown`, not `series` — a hidden series must leave the plot so
              the y-axis rescales to what is left. Rendering it transparent
              would keep the axis pinned to the value you were trying to
              exclude. */}
          {shown.map((s) => (
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
          {/* The live drag selection. */}
          {dragFrom && dragTo ? (
            <ReferenceArea x1={dragFrom} x2={dragTo} strokeOpacity={0} fill="var(--primary)" fillOpacity={0.12} />
          ) : null}
        </AreaChart>
      </ChartContainer>

      {/* Clicking a series name hides it and the axis rescales — the only way
          to read a small series sitting under a large one. The last visible
          series cannot be hidden; an empty chart is not a state worth
          reaching by accident. */}
      <div className="flex flex-wrap gap-3.5 text-[0.75rem]">
        {series.map((s) => {
          const off = hiddenSeries.has(s.key)
          const isLastVisible = !off && shown.length === 1
          return (
            <button
              key={s.key}
              onClick={() =>
                setHiddenSeries((prev) => {
                  const next = new Set(prev)
                  if (next.has(s.key)) next.delete(s.key)
                  else if (!isLastVisible) next.add(s.key)
                  return next
                })
              }
              disabled={isLastVisible}
              aria-pressed={!off}
              title={isLastVisible ? "At least one series stays visible" : undefined}
              className={cn(
                "inline-flex items-center gap-1.5 transition-opacity",
                off ? "text-faint-foreground line-through" : "text-muted-foreground",
                isLastVisible ? "cursor-default" : "cursor-pointer hover:text-foreground"
              )}
            >
              <i
                className="inline-block size-2 rounded-[2px]"
                style={{ background: off ? "var(--faint-foreground)" : s.color }}
              />
              {s.label}
            </button>
          )
        })}
        {zoom ? (
          <span className="text-faint-foreground">
            showing {visible.length} of {data.length}
          </span>
        ) : null}
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
  onSelect,
  selected,
}: {
  /**
   * `count: null` means suppressed, not zero.
   *
   * A category with too few contributors is still listed — an organiser needs
   * to know a safety concern was raised — but the number is withheld, because
   * "1 safety_conduct" in a room of six is a sentence with an author. Rendering
   * null as 0 would be worse than either: a false reassurance.
   */
  data: Array<{ category: string; count: number | null; suppressed?: boolean }>
  title?: string
  hint?: string
  empty?: boolean
  emptyText?: string
  /**
   * Click-to-filter. Given this, a bar becomes the way into the rows behind
   * it — "safety_conduct is up" turns into "here are the eleven messages",
   * which is the single most useful thing a chart on this page can do.
   */
  onSelect?: (category: string | null) => void
  selected?: string | null
}) {
  const max = Math.max(1, ...data.map((d) => d.count ?? 0))
  return (
    <ChartFrame title={title} hint={hint} empty={empty} emptyText={emptyText}>
      <div className="flex flex-col gap-1.5">
        {data.map((d) => {
          const safety = d.category === "safety_conduct"
          const isSelected = selected === d.category
          const Row = onSelect ? "button" : "div"
          return (
            <Row
              key={d.category}
              // Clicking the selected bar again clears the filter — the same
              // gesture out as in, so nobody hunts for a reset.
              {...(onSelect
                ? {
                    onClick: () => onSelect(isSelected ? null : d.category),
                    "aria-pressed": isSelected,
                    title: isSelected ? "Clear this filter" : `Filter to ${d.category.replace(/_/g, " ")}`,
                  }
                : {})}
              className={cn(
                "flex w-full items-center gap-2.5 rounded px-1 py-0.5 text-left",
                onSelect && "cursor-pointer transition-colors hover:bg-accent",
                isSelected && "bg-accent"
              )}
            >
              <span
                className={cn(
                  "w-24 shrink-0 text-right text-[0.75rem]",
                  safety ? "font-medium text-destructive" : "text-muted-foreground",
                  isSelected && "font-bold text-foreground"
                )}
              >
                {d.category.replace(/_/g, " ")}
              </span>
              <div className="h-4 flex-1 overflow-hidden rounded bg-surface-raised">
                <div
                  className={cn(
                    "h-full rounded transition-opacity",
                    safety ? "bg-destructive" : "bg-chart-1",
                    // Dim the others rather than hide them: the selected bar
                    // still needs something to be big or small against.
                    selected && !isSelected && "opacity-40"
                  )}
                  style={{ width: `${barWidth(d.count ?? 0, max)}%` }}
                />
              </div>
              <span className="w-16 text-[0.75rem] tabular-nums">
                {d.count === null ? (
                  <b
                    className="font-bold text-muted-foreground"
                    title="Too few people raised this to show a count without identifying them"
                  >
                    &lt;5
                  </b>
                ) : (
                  <b className="font-bold">{d.count}</b>
                )}
                {safety ? <span className="text-destructive"> → mod</span> : null}
              </span>
            </Row>
          )
        })}
      </div>
    </ChartFrame>
  )
}

/* -------------------------------------------------------------------------- */

export type AttendanceDay = {
  occursOn: string
  unique: number
  newcomers: number
  returning: number
  cancelled: boolean
}

/**
 * Per-day attendance for a multi-day run — new against returning.
 *
 * The question a conference actually asks is not "how many came" but **did it
 * hold**. A run that draws 400 on Monday and 120 on Wednesday has a problem the
 * total attendance figure hides completely, so returning sits on the bottom of
 * the stack where its shrinking is visible against the axis.
 *
 * Cancelled days keep their slot, hatched. Dropping them would leave an
 * unexplained gap in the dates; drawing them as a zero bar would read as a day
 * nobody came to. They are excluded from every denominator — `lib/attendance.ts`
 * does that upstream, and the hint says so.
 *
 * Single-day events never reach here: one bar is a worse answer than one
 * number, and `AttendancePanel` renders the number instead.
 */
export function AttendanceDays({
  days,
  retentionPct,
}: {
  days: AttendanceDay[]
  retentionPct: number | null
}) {
  const ran = days.filter((d) => !d.cancelled)
  const fmt = (iso: string) =>
    new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" })

  return (
    <ChartFrame
      title="Did it hold?"
      hint="cancelled days sit outside every denominator"
      empty={ran.every((d) => d.unique === 0)}
      emptyText="Per-day attendance fills in as people check in."
    >
      <div className="flex flex-col gap-2">
        <ChartContainer
          config={{
            returning: { label: "Came back", color: "var(--chart-3)" },
            newcomers: { label: "New that day", color: "var(--chart-1)" },
          }}
          className="h-[180px] w-full"
        >
          <BarChart data={days} margin={{ left: 4, right: 12, top: 16 }}>
            <defs>
              <pattern
                id="attendance-cancelled"
                width={7}
                height={7}
                patternTransform="rotate(45)"
                patternUnits="userSpaceOnUse"
              >
                <line x1="0" y1="0" x2="0" y2="7" stroke="var(--border-strong)" strokeWidth={1.5} />
              </pattern>
            </defs>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="occursOn"
              tickFormatter={fmt}
              tickLine={false}
              axisLine={false}
              tickMargin={8}
            />
            {/* Whole people only — half an attendee is not a reading. */}
            <YAxis allowDecimals={false} width={28} tickLine={false} axisLine={false} />
            {days
              .filter((d) => d.cancelled)
              .map((d) => (
                <ReferenceArea
                  key={d.occursOn}
                  x1={d.occursOn}
                  x2={d.occursOn}
                  fill="url(#attendance-cancelled)"
                  stroke="var(--border-strong)"
                  strokeDasharray="3 3"
                  label={{ value: "cancelled", fontSize: 9, fill: "var(--muted-foreground)" }}
                />
              ))}
            <ChartTooltip content={<ChartTooltipContent labelFormatter={(l) => fmt(String(l))} />} />
            <Bar dataKey="returning" stackId="day" fill="var(--color-returning)" />
            <Bar dataKey="newcomers" stackId="day" fill="var(--color-newcomers)" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ChartContainer>
        {retentionPct !== null && ran.length >= 2 ? (
          <p className="text-[0.8125rem]">
            <span className="font-bold">Held {retentionPct}%</span>
            <span className="text-muted-foreground">
              {" "}
              — of day one&rsquo;s {ran[0].unique},{" "}
              {Math.round((ran[0].unique * retentionPct) / 100)} were back on the final day.
            </span>
          </p>
        ) : null}
      </div>
    </ChartFrame>
  )
}
