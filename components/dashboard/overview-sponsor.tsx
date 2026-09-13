import Link from "next/link"

import { EmptyState, MetricTile, SectionTitle } from "@/components/dashboard/primitives"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { SponsorOverview } from "@/lib/dashboard-types"
import { formatNumber } from "@/lib/dashboard-format"

/**
 * The sponsor's landing page.
 *
 * There was none. `getDashboardOverview` branched on `app_admin` and
 * `venue_owner` and fell through to the organiser build, scoped to
 * `organizer_id = <the sponsor's own user id>` — a column that is never theirs.
 * Every sponsor's home screen therefore read all zeros, permanently, and looked
 * like a quiet month rather than a screen asking the wrong question entirely.
 *
 * ## The hero is readiness, not reach
 *
 * `DESIGN_SYSTEM.md` says each role leads with its forward-looking question. A
 * sponsor's question at 8pm is not "how did last month go" — it is *"is my ad
 * going to run tonight, and is anything blocking it."* Reach answers a Monday
 * question and belongs in a tile. `getSponsorOverview` already made that call
 * for `/dashboard/placements`; this screen inherits it rather than re-deciding.
 *
 * Server component: it renders values and one link, and hands no callbacks to a
 * client table — so it does not need to be a client component the way the venue
 * overview does.
 */
export function OverviewSponsor({ data }: { data: SponsorOverview }) {
  if (!data.brandName) {
    return (
      <EmptyState
        title="No brand yet"
        description="Everything here hangs off a brand: campaigns are attached to one, and an organiser has to be able to find you by name. Set one up and this fills in."
        action={
          <Button asChild size="sm">
            <Link href="/dashboard/brand">Set up your brand</Link>
          </Button>
        }
      />
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <section className="rounded-lg border border-border bg-card px-5 py-5">
        <p className="text-[0.8125rem] font-semibold uppercase tracking-wide text-muted-foreground">
          {data.brandName}
        </p>
        {data.next ? (
          <>
            <div className="mt-2 flex flex-wrap items-baseline gap-3">
              <span className="text-[length:var(--text-metric-hero)] font-bold leading-[1.05]">
                {data.next.eventTitle}
              </span>
              <Badge variant={data.next.ready ? "secondary" : "destructive"}>
                {data.next.ready ? "Ready to run" : "Blocked"}
              </Badge>
            </div>
            <p className="mt-1 text-[0.875rem] text-muted-foreground">
              {new Date(data.next.startTime).toLocaleString("en-GB", {
                weekday: "short",
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
              })}
              {/*
                The blocker verbatim. `canActivate` distinguishes several
                reasons and each has a different fix, so flattening them to
                "not ready" would name none of them.
              */}
              {data.next.blocker ? ` · ${data.next.blocker}` : null}
            </p>
          </>
        ) : (
          <p className="mt-2 text-[0.875rem] text-muted-foreground">
            Nothing scheduled. An organiser attaches your brand to an event, and it appears
            here once they do.
          </p>
        )}
      </section>

      <div className="flex flex-wrap gap-1">
        <MetricTile label="Running now" value={data.liveNow} hint="campaigns live in a room" />
        <MetricTile
          label="Waiting on you"
          value={data.awaitingYou}
          hint="placements to accept or decline"
        />
        <MetricTile
          label="Reach, 30 days"
          value={
            data.reach30dSuppressed || data.reach30d === null
              ? "—"
              : formatNumber(data.reach30d)
          }
          /*
           * Suppressed rather than rounded to zero. Below the disclosure floor
           * a count of distinct people in a small room is close to naming them,
           * and "—" says the number exists and is being withheld, where "0"
           * would be a lie about the campaign.
           */
          hint={
            data.reach30dSuppressed
              ? "too few people to report without identifying them"
              : "distinct people, your sends only"
          }
        />
      </div>

      <section className="flex flex-col gap-2">
        <SectionTitle>Your campaigns</SectionTitle>
        <p className="text-[0.8125rem] text-muted-foreground">
          Every placement, what it costs and whether it ran, lives on the placements screen.
        </p>
        <div>
          <Button asChild size="sm" variant="secondary">
            <Link href="/dashboard/placements">Open placements</Link>
          </Button>
        </div>
      </section>
    </div>
  )
}
