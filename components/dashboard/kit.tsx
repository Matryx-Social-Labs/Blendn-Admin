import Link from "next/link"
import type { ReactNode } from "react"
import { IconLock } from "@tabler/icons-react"

import { MetricTile } from "@/components/dashboard/primitives"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

/**
 * The organiser kit's building blocks (`ui_kits/organiser/ui.jsx`), on the
 * repo's tokens.
 *
 * `PageHeader` is not here, on purpose: it owns the page's only `h1`, and
 * `dashboard-header-title.test.ts` reads every file a page imports for an
 * `h1`. A page that imported a Panel from a file that also held the h1 would
 * fail that guard for something it never rendered.
 */

/* -------------------------------------------------------------------------- */

/**
 * The bordered group every screen is built from (R3): card background, 1px
 * border, 12px radius, a 15px title with a faint hint beside it, and an
 * optional action on the right. It groups; it does not rank. One `HeroMetric`
 * per screen does that, and a Panel never holds another bordered box.
 */
export function Panel({
  title,
  hint,
  action,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode
  hint?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col rounded-panel border border-border bg-card",
        className
      )}
    >
      {title || action ? (
        <div className="flex items-center justify-between gap-3 px-5 pt-4">
          <div className="flex min-w-0 items-baseline gap-2.5">
            {title ? (
              <h2 className="whitespace-nowrap text-panel-title font-bold">{title}</h2>
            ) : null}
            {hint ? <span className="min-w-0 text-[0.75rem] text-faint-foreground">{hint}</span> : null}
          </div>
          {action}
        </div>
      ) : null}
      <div className={cn("flex flex-col gap-3.5 p-5", bodyClassName)}>{children}</div>
    </section>
  )
}

/* -------------------------------------------------------------------------- */

/** The Analytics plan's mark: on locked tiles, locked previews and the plan card. */
export function ProTag() {
  return (
    <span className="inline-flex rounded-full bg-[image:var(--gradient-ember)] px-1.5 py-0.5 text-[0.625rem] font-bold uppercase tracking-[0.06em] text-brand-ink">
      Analytics
    </span>
  )
}

/* -------------------------------------------------------------------------- */

type OpenKpi = React.ComponentProps<typeof MetricTile> & { locked?: false }

/**
 * A KPI the account's plan does not include. It has no `value`, by type: a
 * locked tile shows a lock and the plan's name, never the number — not even
 * blurred, because a blurred number is a number in the page source.
 */
export interface LockedKpi {
  label: string
  locked: true
  /** One line under the lock. Defaults to "Unlock with Analytics". */
  lockHint?: string
  /** Where unlocking happens, once there is somewhere (the Plan page, step 16). */
  href?: string
}

/**
 * A row of KPIs in one bordered strip, divided by hairlines. Open tiles are the
 * existing `MetricTile`, chrome-less inside the strip.
 */
export function KpiStrip({ items }: { items: Array<OpenKpi | LockedKpi> }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] overflow-hidden rounded-panel border border-border bg-card">
      {items.map((item, i) => (
        <div key={item.label} className={cn("relative p-1", i > 0 && "border-l border-border")}>
          {item.locked ? <LockedTile tile={item} /> : <MetricTile {...item} />}
        </div>
      ))}
    </div>
  )
}

/**
 * Reads `label`, `lockHint` and `href` by name and nothing else, so a value
 * that reached a locked item anyway (a cast, a spread of the open tile's
 * props) still never renders.
 */
function LockedTile({ tile }: { tile: LockedKpi }) {
  const body = (
    <>
      <span className="text-[0.75rem] font-medium uppercase tracking-[0.06em] text-muted-foreground">
        {tile.label}
      </span>
      <span className="flex h-[31px] items-center gap-2">
        <IconLock aria-hidden className="size-[18px] text-faint-foreground" />
        <ProTag />
      </span>
      <span className="min-h-[18px] text-[0.75rem] text-faint-foreground">
        {tile.lockHint ?? "Unlock with Analytics"}
      </span>
    </>
  )
  const shared = "flex flex-col gap-1 rounded-lg px-3.5 py-3"
  return tile.href ? (
    <Link href={tile.href} className={cn(shared, "transition-colors hover:bg-accent/60")}>
      {body}
    </Link>
  ) : (
    <div className={shared}>{body}</div>
  )
}

/* -------------------------------------------------------------------------- */

/**
 * A paid feature, previewed blurred behind its pitch.
 *
 * ## The preview is a static sample, never the organisation's data
 *
 * `sample` is the only content this renders behind the blur, and it must be a
 * fixed illustration written in source — invented numbers, invented labels.
 * Never pass it the real chart with the real query behind it:
 *
 *   - **The blur is CSS.** The numbers would be in the HTML, in the RSC
 *     payload and in the accessibility tree's neighbours; "Analytics" would be
 *     a stylesheet away from free.
 *   - **Real data under a floor is still real data.** A preview computed from
 *     the org's own rows sidesteps the suppression floors (`lib/disclosure.ts`)
 *     that the paid screen applies, and can reveal a count of fewer than five.
 *   - The owner ruled it (2026-10-01, design-kit README): locked previews use
 *     static sample data.
 *
 * So there is deliberately no `data`, `value` or `rows` prop to thread real
 * numbers through, and `__tests__/dashboard-kit.test.tsx` pins that at the type level.
 */
export function Locked({
  title,
  body,
  sample,
  action,
  height = 260,
}: {
  title: string
  body: string
  /** A static illustration of the paid view. See above: never real data. */
  sample: ReactNode
  /** The unlock call to action, e.g. a link to the plan page once it exists. */
  action?: ReactNode
  height?: number
}) {
  return (
    <div className="relative overflow-hidden rounded-panel border border-border">
      <div
        aria-hidden="true"
        inert
        data-locked-sample=""
        className="pointer-events-none overflow-hidden opacity-45 blur-[6px] select-none"
        style={{ height }}
      >
        {sample}
      </div>
      <div className="absolute inset-0 flex items-center justify-center bg-linear-to-b from-background/30 to-background/80 p-6">
        <div className="flex max-w-[420px] flex-col items-center gap-2.5 text-center">
          <ProTag />
          <p className="text-[1.0625rem] font-bold">{title}</p>
          <p className="text-[0.84375rem] leading-[22px] text-muted-foreground">{body}</p>
          {action ? <div className="mt-1">{action}</div> : null}
        </div>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

/** A list row inside a Panel: hairline above, hover only when it goes somewhere. */
export function Row({
  children,
  href,
  className,
}: {
  children: ReactNode
  href?: string
  className?: string
}) {
  const shared = cn(
    "flex items-center gap-3.5 border-t border-border px-4 py-3 transition-colors",
    className
  )
  return href ? (
    <Link
      href={href}
      className={cn(
        shared,
        "hover:bg-accent focus-visible:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      )}
    >
      {children}
    </Link>
  ) : (
    <div className={shared}>{children}</div>
  )
}

/* -------------------------------------------------------------------------- */

/**
 * The calendar tile on an event row. The caller formats `day` and `month` on
 * the event's own clock (`eventClock`), so the tile never guesses a timezone.
 * While the event runs, the month gives way to "Live".
 */
export function DateBlock({ day, month, live }: { day: string | number; month: string; live?: boolean }) {
  return (
    <div
      className={cn(
        "flex w-11 shrink-0 flex-col items-center rounded-[10px] border bg-surface-raised py-[5px]",
        live ? "border-destructive/50" : "border-border"
      )}
    >
      <span
        className={cn(
          "text-[0.625rem] font-medium uppercase tracking-[0.08em]",
          live ? "text-destructive" : "text-muted-foreground"
        )}
      >
        {live ? "Live" : month}
      </span>
      <span className="text-[1.0625rem] font-bold leading-[1.1]">{day}</span>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

/** The pulsing red dot that means "happening now". Decoration: the word says it. */
export function LiveDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-[7px] shrink-0 animate-pulse rounded-full bg-destructive motion-reduce:animate-none",
        className
      )}
    />
  )
}

const STATUS_WORD = {
  published: { label: "Published", className: "text-faint-foreground" },
  draft: { label: "Draft", className: "font-bold" },
  cancelled: { label: "Cancelled", className: "font-bold text-destructive" },
  completed: { label: "Completed", className: "text-muted-foreground" },
} as const

/**
 * An event's state as a word, not a coloured chip. Live outranks the stored
 * status; a published event with no check-in fence says so, because nobody can
 * check in to it.
 */
export function Status({
  status,
  live,
  unfenced,
}: {
  status: keyof typeof STATUS_WORD
  live?: boolean
  unfenced?: boolean
}) {
  if (live) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[0.8125rem] font-bold">
        <LiveDot />
        Live
      </span>
    )
  }
  const word = STATUS_WORD[status]
  return (
    <span className="inline-flex items-center gap-1.5 text-[0.8125rem]">
      <span className={word.className}>{word.label}</span>
      {unfenced && status === "published" ? (
        <Badge variant="destructive" className="text-[0.6875rem]">
          no fence
        </Badge>
      ) : null}
    </span>
  )
}

/* -------------------------------------------------------------------------- */

/**
 * Link-based pill tabs. Each tab is a URL, so a tab can be linked to, opened in
 * a new tab, and survives a reload. `live` puts the live dot on a tab.
 */
export function PillTabs({
  label,
  tabs,
  active,
}: {
  /** Names the `<nav>` for a screen reader, e.g. "Event sections". */
  label: string
  tabs: Array<{ key: string; label: string; href: string; live?: boolean }>
  active: string
}) {
  return (
    <nav className="flex flex-wrap gap-1.5" aria-label={label}>
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          aria-current={tab.key === active ? "page" : undefined}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-[0.8125rem] transition-colors pointer-coarse:min-h-11",
            tab.key === active
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:bg-accent hover:text-foreground"
          )}
        >
          {tab.label}
          {tab.live ? <LiveDot className="size-1.5" /> : null}
        </Link>
      ))}
    </nav>
  )
}
