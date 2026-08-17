import { redirect } from "next/navigation"
import { IconMicrophone2 } from "@tabler/icons-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { EmptyState, HeroMetric, MetricTile } from "@/components/dashboard/primitives"
import { getAuth } from "@/lib/auth"
import { canAccessDashboard } from "@/lib/rbac"
import { getSponsorOverview } from "@/lib/sponsor-actions"

import { PlacementDecision } from "./decision"

export const dynamic = "force-dynamic"

const dateTime = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
})

/** How long until doors, in the coarsest unit that is still useful. */
function until(when: Date, now: Date): string {
  const ms = when.getTime() - now.getTime()
  if (ms <= 0) return "now"
  const mins = Math.round(ms / 60000)
  if (mins < 60) return `in ${mins}m`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `in ${hours}h`
  return `in ${Math.round(hours / 24)}d`
}

const PHASE_LABEL: Record<string, string> = {
  draft: "Draft",
  proposed: "Awaiting you",
  upcoming: "Upcoming",
  live: "Live",
  ended: "Ended",
  cancelled: "Cancelled",
}

/**
 * The sponsor's home.
 *
 * ## The hero is readiness, not reach
 *
 * `docs/DESIGN_SYSTEM.md:139` puts the forward-looking question before any
 * trailing report, and a sponsor's question at 8pm is "is my ad going to run
 * tonight" — not "how did last month go". Reach is a Monday question and lives
 * in a tile.
 *
 * Exactly one `HeroMetric`, per the same document: a second gradient element
 * would mean the screen has two priorities and one of them is wrong.
 *
 * When the next placement is blocked, the hero says why instead of counting down
 * to something that will not happen.
 */
export default async function PlacementsPage() {
  const session = await getAuth()
  if (!session?.user) redirect("/login")
  if (!canAccessDashboard(session.user.role)) redirect("/dashboard")

  const overview = await getSponsorOverview()
  const now = new Date()

  /*
   * No brand means everything else is blocked on it, so this is ONE empty state
   * rather than a dashboard of four. A brand-new sponsor account otherwise
   * lands on four dashed boxes, which reads as a broken page.
   */
  if (!overview.brandName) {
    return (
      <div className="flex flex-col gap-6 py-6">
        <div className="px-4 lg:px-6">
          <EmptyState
            icon={<IconMicrophone2 className="size-6" />}
            title="Add your brand first"
            description="Your name and logo are what attendees see beside a sponsored message. Once your brand is set up, placements organisers offer you appear here."
            action={
              <Button asChild size="sm">
                <a href="/dashboard/brand">Set up your brand</a>
              </Button>
            }
          />
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6 py-6">
      <div className="px-4 lg:px-6">
        {overview.next ? (
          <HeroMetric
            eyebrow="Next placement"
            value={overview.next.ready ? until(overview.next.startTime, now) : "Blocked"}
            description={
              overview.next.ready
                ? `${overview.next.eventTitle} · ${dateTime.format(overview.next.startTime)}`
                : `${overview.next.eventTitle} — ${overview.next.blocker}`
            }
            tone={overview.next.ready ? "brand" : "muted"}
          />
        ) : (
          <HeroMetric
            eyebrow="Next placement"
            value="None scheduled"
            description="When an organiser offers your brand a placement, it appears here for you to accept."
            tone="muted"
          />
        )}
      </div>

      {/*
        Container queries, not viewport breakpoints. The sidebar is 288px and
        collapsible, so viewport and content width differ by a changing amount —
        `DESIGN_SYSTEM.md:89` records two grids falling visibly out of step when
        one used `md:` and the other did not.
      */}
      <div className="grid gap-6 px-4 @xl/main:grid-cols-2 @5xl/main:grid-cols-4 lg:px-6">
        <MetricTile label="Live now" value={overview.liveNow} />
        <MetricTile
          label="Awaiting you"
          value={overview.awaitingYou}
          hint={overview.awaitingYou > 0 ? "needs a decision" : undefined}
        />
        {/*
          `null`, not `0`. Nothing has run yet, and "Reach 0" reads as failure
          where an em dash reads as "not yet" — the distinction MetricTile was
          built to carry.
        */}
        <MetricTile
          label="Reach (30d)"
          value={overview.reach30d}
          hint={overview.reach30dSuppressed ? "fewer than 5 people" : "distinct people"}
        />
        <MetricTile label="Brand" value={overview.brandName} />
      </div>

      <section className="flex flex-col gap-3 px-4 lg:px-6">
        {/* h2, not h1 — components/site-header.tsx owns the page's only h1. */}
        <h2 className="text-[0.9375rem] font-bold">Placements</h2>

        {overview.placements.length === 0 ? (
          <EmptyState
            description="No placements yet. When an organiser adds your brand to an event, it appears here — you will be asked to accept before anything runs."
            compact
          />
        ) : (
          <div className="flex flex-col divide-y rounded-xl border bg-card">
            {overview.placements.map((p) => (
              <div
                key={p.id}
                className="flex flex-col gap-2 p-4 @2xl/main:flex-row @2xl/main:items-center @2xl/main:justify-between"
              >
                <div className="flex flex-col gap-1">
                  <span className="font-medium">{p.eventTitle}</span>
                  <span className="text-[0.8125rem] text-muted-foreground">
                    {dateTime.format(p.startTime)}
                    {p.blocker ? ` · ${p.blocker}` : ""}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <Badge variant={p.phase === "live" ? "default" : "outline"}>
                    {PHASE_LABEL[p.phase] ?? p.phase}
                  </Badge>
                  <span className="text-[0.8125rem] text-muted-foreground">
                    {/* Em dash for "has not run", never 0. */}
                    {p.sends === null ? "— sends" : `${p.sends} sends`}
                  </span>
                  {p.status === "proposed" ? <PlacementDecision placementId={p.id} /> : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
