import { redirect } from "next/navigation"
import { IconMicrophone2, IconSpeakerphone } from "@tabler/icons-react"

import { KpiStrip, LiveDot, Panel } from "@/components/dashboard/kit"
import { Button } from "@/components/ui/button"
import { EmptyState, HeroMetric } from "@/components/dashboard/primitives"
import { formatNumber } from "@/lib/dashboard-format"
import { cn } from "@/lib/utils"
import { getAuth } from "@/lib/auth"
import { mayReachRoute } from "@/lib/dashboard-nav"
import { eventClock } from "@/lib/event-phase"
import { getSponsorOverview } from "@/lib/sponsor-actions"

import { PlacementDecision } from "./decision"

import { routeMetadata } from "@/lib/dashboard-route-content"

// The tab says what the h1 says (WCAG 2.4.2).
export const metadata = routeMetadata("/dashboard/placements")

export const dynamic = "force-dynamic"

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
  // From the nav's own `allowedRoles`, so the menu and the gate cannot
  // disagree. This called `canAccessDashboard`, which is true for all four
  // dashboard roles, while the nav has always presented this as sponsor-only.
  if (!mayReachRoute(session.user.role, "/dashboard/placements")) redirect("/dashboard")

  const overview = await getSponsorOverview()
  const now = new Date()

  /*
   * No brand means everything else is blocked on it, so this is ONE empty state
   * rather than a dashboard of four. A brand-new sponsor account otherwise
   * lands on four dashed boxes, which reads as a broken page.
   */
  if (!overview.brandName) {
    return (
      <div className="flex flex-col gap-5">
        <div>
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

  const money = (minor: number, currency: string) =>
    new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 2 }).format(minor / 100)

  return (
    <div className="flex flex-col gap-5">
      <div className={overview.nextCreative ? "grid gap-5 @3xl/main:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]" : "grid gap-5"}>
        {overview.next ? (
          <HeroMetric
            eyebrow={`Next placement${overview.next.ready ? "" : " · blocked"}`}
            value={overview.next.ready ? until(overview.next.startTime, now) : "Blocked"}
            description={
              overview.next.ready
                ? `${overview.next.eventTitle} · ${eventClock(overview.next.timezone).dateTime(overview.next.startTime)}`
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
        {overview.nextCreative ? (
          // The approved copy as the room shows it: a sponsored message, never a banner.
          <Panel title="Room preview">
            <div className="flex flex-col gap-1.5 rounded-[10px] border border-[color-mix(in_oklch,var(--chart-3)_40%,transparent)] bg-[color-mix(in_oklch,var(--chart-3)_12%,var(--card))] px-3.5 py-3">
              <span className="inline-flex items-center gap-1.5 text-[0.71875rem] font-bold uppercase tracking-[0.06em] text-muted-foreground">
                <IconSpeakerphone aria-hidden className="size-3.5" />
                Sponsored · {overview.brandName}
              </span>
              <span className="text-[0.84375rem] leading-5">{overview.nextCreative}</span>
            </div>
            <span className="text-[0.75rem] text-faint-foreground">Approved by creative review · as attendees see it</span>
          </Panel>
        ) : null}
      </div>

      <KpiStrip
        items={[
          { label: "Live now", value: overview.liveNow, hint: "campaigns in a room" },
          {
            label: "Awaiting you",
            value: overview.awaitingYou,
            hint: overview.awaitingYou > 0 ? "needs a decision" : "nothing to decide",
          },
          {
            label: "Reach (30d)",
            value: overview.reach30d === null ? null : formatNumber(overview.reach30d),
            hint:
              overview.reach30d === null
                ? overview.reach30dSuppressed
                  ? "under 5 people, not reported"
                  : "nothing has run yet"
                : overview.reach30dSuppressed
                  ? "people per night, added up · small nights left out"
                  : "people per night, added up",
          },
          { label: "Brand", value: overview.brandName, hint: "as attendees see it" },
        ]}
      />

      <Panel title="All placements" bodyClassName="gap-0 px-0 pb-0 pt-3">
        {overview.placements.length === 0 ? (
          <div className="px-5 pb-5">
            <EmptyState
              description="No placements yet. When an organiser adds your brand to an event, it appears here — you will be asked to accept before anything runs."
              compact
            />
          </div>
        ) : (
          <ul className="flex flex-col">
            {overview.placements.map((p) => (
              <li
                key={p.id}
                className="flex flex-col gap-2 border-t border-border px-5 py-3.5 @2xl/main:flex-row @2xl/main:items-center @2xl/main:gap-4"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-[0.875rem] font-medium">{p.eventTitle}</span>
                  <span className="text-[0.8125rem] text-muted-foreground">
                    {/* The event's clock, not the server's (SCRUM-496). */}
                    {eventClock(p.timezone).dateTime(p.startTime)}
                    {p.blocker ? <span className="text-warning"> · {p.blocker}</span> : null}
                  </span>
                </div>
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 text-[0.8125rem]",
                    (p.phase === "proposed" || p.phase === "live") && "font-bold",
                    p.phase === "proposed" && "text-primary"
                  )}
                >
                  {p.phase === "live" ? <LiveDot /> : null}
                  {PHASE_LABEL[p.phase] ?? p.phase}
                </span>
                <span className="text-[0.8125rem] text-muted-foreground @2xl/main:w-20 @2xl/main:text-right">
                  {/* Em dash for "has not run", never 0. */}
                  {p.sends === null ? "— sends" : `${p.sends} send${p.sends === 1 ? "" : "s"}`}
                </span>
                <span className="text-[0.8125rem] text-muted-foreground @2xl/main:w-36 @2xl/main:text-right">
                  {p.reach !== null
                    ? `${formatNumber(p.reach)} reached`
                    : p.reachSuppressed
                      ? "held back · under 5"
                      : "— reached"}
                </span>
                {/* One fixed slot for the row's action, so the columns line up row to row. */}
                <span className="flex @2xl/main:w-[170px] @2xl/main:justify-end">
                  {p.status === "proposed" ? (
                    <PlacementDecision placementId={p.id} />
                  ) : p.due ? (
                    <Button asChild size="sm">
                      <a href={p.due.payUrl} target="_blank" rel="noopener noreferrer">
                        Pay {money(p.due.amountMinor, p.due.currency)}
                      </a>
                    </Button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <p className="text-[0.75rem] text-faint-foreground">
        Reach is distinct people your sends reached, withheld below 5 so a small room can&apos;t be identified. A
        placement is priced by the reach it delivers; the organiser and Blend&apos;n agree the price before anything runs,
        and you pay it by the link on the row.
      </p>
    </div>
  )
}
