import Link from "next/link"

import { KpiStrip, Panel } from "@/components/dashboard/kit"
import { EmptyState, HeroMetric } from "@/components/dashboard/primitives"
import { Button } from "@/components/ui/button"
import type { SponsorOverview } from "@/lib/dashboard-types"
import { formatNumber } from "@/lib/dashboard-format"
import { eventClock } from "@/lib/event-phase"

/**
 * The sponsor's landing page, on the kit (`venue-sponsor.jsx` SponsorHome's
 * hero and tiles; the full list is `/dashboard/placements`).
 *
 * There was none. `getDashboardOverview` branched on `app_admin` and
 * `venue_owner` and fell through to the organiser build, scoped to
 * `organizer_id = <the sponsor's own user id>` — a column that is never theirs.
 * Every sponsor's home screen therefore read all zeros, permanently.
 *
 * ## The hero is readiness, not reach
 *
 * `DESIGN_SYSTEM.md` says each role leads with its forward-looking question. A
 * sponsor's question at 8pm is not "how did last month go" — it is *"is my ad
 * going to run tonight, and is anything blocking it."* Blocked, the hero says
 * so with the blocker verbatim (its memorable detail). Reach answers a Monday
 * question and sits in a tile.
 *
 * Server component: values and links only.
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

  // The event's clock, not the server's or the viewer's (SCRUM-496).
  const when = data.next
    ? eventClock(data.next.timezone).format(new Date(data.next.startTime), {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null

  return (
    <div className="flex flex-col gap-5">
      {data.next ? (
        <HeroMetric
          eyebrow={`Next placement · ${data.brandName}`}
          value={data.next.ready ? "Ready to run" : "Blocked"}
          unit={`in ${data.next.eventTitle}`}
          // The blocker verbatim: each has a different fix, and "not ready" names none.
          description={data.next.blocker ? `${when} · ${data.next.blocker}` : (when ?? undefined)}
          tone={data.next.ready ? "brand" : "muted"}
        />
      ) : (
        <HeroMetric
          eyebrow={`Next placement · ${data.brandName}`}
          value="None scheduled"
          description="An organiser attaches your brand to an event, and it appears here once they do."
          tone="muted"
        />
      )}

      <KpiStrip
        items={[
          { label: "Live now", value: data.liveNow, hint: "campaigns in a room" },
          { label: "Awaiting you", value: data.awaitingYou, hint: "placements to accept or decline" },
          {
            label: "Reach (30d)",
            value: data.reach30d === null ? null : formatNumber(data.reach30d),
            /*
             * Withheld rather than rounded to zero. Below the disclosure floor
             * a count of people in a small room is close to naming them, and
             * "—" says the number exists and is withheld, where "0" would be a
             * lie about the campaign.
             */
            hint:
              data.reach30d === null
                ? data.reach30dSuppressed
                  ? "under 5 people, not reported"
                  : "nothing has run yet"
                : data.reach30dSuppressed
                  ? "people per night, added up · small nights left out"
                  : "people per night, added up",
          },
        ]}
      />

      <Panel title="Your placements" hint="what runs where, and what each reached">
        <div>
          <Button asChild size="sm" variant="secondary">
            <Link href="/dashboard/placements">Open placements</Link>
          </Button>
        </div>
      </Panel>
    </div>
  )
}
