import Link from "next/link"
import type { ReactNode } from "react"

import { barWidth } from "@/lib/dashboard-view"
import { cn } from "@/lib/utils"

/**
 * Dashboard design-system primitives.
 *
 * The governing idea, from the redesign: **hierarchy comes from type, not
 * boxes**. The previous dashboard put every number in a bordered rounded card
 * at identical visual weight — a hero card, four KPI cards, five spotlight
 * cards, two chart cards and a table card — so nothing read as primary and the
 * eye had nowhere to land.
 *
 * So: `MetricTile` has no card chrome at all, and exactly one `HeroMetric` per
 * screen carries the brand gradient. If a second element on a screen wants the
 * gradient, the screen has two priorities and one of them is wrong.
 */

/* -------------------------------------------------------------------------- */

export function DeltaBadge({
  value,
  /** For metrics where down is good — no-show rate, moderation backlog. */
  invert = false,
  /**
   * `pts` when the metric is itself a percentage.
   *
   * A turn-up rate going 60% → 66% is "+6 pts". Rendering that as "+6%" invites
   * reading it as 70%, which is a different number entirely.
   */
  suffix = "%",
  className,
}: {
  value: number
  invert?: boolean
  suffix?: string
  className?: string
}) {
  const flat = value === 0
  const good = invert ? value < 0 : value > 0
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-[0.75rem] font-medium tabular-nums",
        flat ? "text-faint-foreground" : good ? "text-success" : "text-destructive",
        className
      )}
    >
      {flat ? "±" : good ? "↑" : "↓"}
      {Math.abs(value)}
      {suffix === "%" ? "%" : ` ${suffix}`}
    </span>
  )
}

/* -------------------------------------------------------------------------- */

/**
 * Quiet KPI. No border, no background until hovered — the label/value/hint
 * stack does the work. Clickable by default because a metric you cannot follow
 * to its detail is a decoration.
 */
export function MetricTile({
  label,
  value,
  delta,
  deltaInvert,
  deltaSuffix,
  hint,
  href,
  className,
}: {
  label: string
  /** `null` renders an em dash — "not applicable yet", distinct from zero. */
  value: string | number | null
  delta?: number
  deltaInvert?: boolean
  /** `pts` for metrics that are themselves percentages. */
  deltaSuffix?: string
  hint?: string
  href?: string
  className?: string
}) {
  const body = (
    <>
      <span className="text-[0.75rem] font-medium uppercase tracking-[0.06em] text-muted-foreground">
        {label}
      </span>
      <span className="text-[length:var(--text-metric)] font-bold leading-[1.1] tabular-nums">
        {value ?? "—"}
      </span>
      <span className="flex min-h-[18px] items-center gap-2">
        {delta !== undefined ? (
          <DeltaBadge value={delta} invert={deltaInvert} suffix={deltaSuffix} />
        ) : null}
        {hint ? <span className="text-[0.75rem] text-faint-foreground">{hint}</span> : null}
      </span>
    </>
  )

  const shared = cn(
    "flex min-w-[130px] flex-col gap-1 rounded-lg px-3.5 py-3 transition-colors",
    href && "hover:bg-card focus-visible:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    className
  )

  return href ? (
    <Link href={href} className={shared}>
      {body}
    </Link>
  ) : (
    <div className={shared}>{body}</div>
  )
}

/* -------------------------------------------------------------------------- */

/**
 * The one loud element per screen. The brand gradient is reserved for this and
 * for the funnel/pacing accents — using it everywhere is worse than greyscale.
 */
export function HeroMetric({
  eyebrow,
  value,
  unit,
  description,
  progress,
  action,
  tone = "brand",
}: {
  eyebrow?: string
  value: string | number | null
  unit?: string
  description?: string
  /** 0-100, or null when there is no target to measure against. */
  progress?: number | null
  action?: ReactNode
  tone?: "brand" | "muted"
}) {
  const pct =
    progress === null || progress === undefined ? null : Math.max(0, Math.min(100, progress))

  return (
    <section className="relative overflow-hidden rounded-lg border border-border bg-card px-5 py-5">
      <div
        aria-hidden
        className="absolute inset-x-0 top-0 h-[3px]"
        style={{ background: tone === "brand" ? "var(--gradient-brand)" : "var(--border)" }}
      />
      {eyebrow ? (
        <p className="text-[0.75rem] font-medium uppercase tracking-[0.06em] text-muted-foreground">
          {eyebrow}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-baseline gap-2">
        <span className="text-[length:var(--text-metric-hero)] font-bold leading-[1.05] tabular-nums">
          {value ?? "—"}
        </span>
        {unit ? <span className="text-base text-muted-foreground">{unit}</span> : null}
      </div>
      {pct !== null ? (
        <div
          role="progressbar"
          aria-valuenow={Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
          className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-raised"
        >
          <div
            className="h-full rounded-full"
            style={{ width: `${pct}%`, background: "var(--gradient-brand)" }}
          />
        </div>
      ) : null}
      {description ? (
        <p className="mt-3 max-w-[56ch] text-sm leading-6 text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </section>
  )
}

/* -------------------------------------------------------------------------- */

/**
 * Empty states are first-class here, not an afterthought: production holds ~44
 * users and 10 events, so most of this product IS empty. Each one says what
 * will fill it and, where there is one, offers the action that starts it.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  compact = false,
}: {
  icon?: ReactNode
  title?: string
  description: string
  action?: ReactNode
  compact?: boolean
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 rounded-lg border border-dashed border-border text-center",
        compact ? "px-4 py-6" : "px-6 py-12"
      )}
    >
      {icon ? <span className="text-muted-foreground [&_svg]:size-7">{icon}</span> : null}
      {title ? <p className="text-[length:var(--text-h2)] font-bold">{title}</p> : null}
      <p className="max-w-[46ch] text-sm leading-6 text-muted-foreground">{description}</p>
      {action}
    </div>
  )
}

/* -------------------------------------------------------------------------- */

/**
 * Rating distribution, 5 stars down to 1.
 *
 * Exists because a mean of 4.2 can be broad agreement or a 5/1 split, and those
 * are completely different events to run next time. The average alone hides it.
 */
export function RatingBars({ counts }: { counts: [number, number, number, number, number] }) {
  const total = counts.reduce((sum, n) => sum + n, 0)
  const max = Math.max(...counts, 1)

  return (
    <div className="flex flex-col gap-1.5">
      {[5, 4, 3, 2, 1].map((star) => {
        const n = counts[star - 1]
        return (
          <div key={star} className="flex items-center gap-2.5">
            <span className="w-8 shrink-0 text-right text-[0.75rem] text-muted-foreground tabular-nums">
              {star}★
            </span>
            <div className="h-4 flex-1 overflow-hidden rounded bg-surface-raised">
              {/* Zero draws as zero. A floor here would claim ratings nobody gave. */}
              <div className="h-full rounded bg-chart-1" style={{ width: `${barWidth(n, max, 3)}%` }} />
            </div>
            <span className="w-8 text-right text-[0.75rem] font-medium tabular-nums">{n}</span>
          </div>
        )
      })}
      <p className="mt-1 text-[0.75rem] text-faint-foreground">
        {total === 0 ? "No ratings yet" : `${total} rating${total === 1 ? "" : "s"}`}
      </p>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

/** Section heading. Pages start at h2 — SiteHeader owns the single h1. */
export function SectionTitle({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h2 className="text-[length:var(--text-h2)] font-bold">{children}</h2>
      {hint ? <span className="text-[0.75rem] text-faint-foreground">{hint}</span> : null}
    </div>
  )
}
