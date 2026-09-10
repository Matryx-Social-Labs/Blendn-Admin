"use client"

// Client because it hands DataTable `render`/`sortValue` functions, and
// DataTable is a client component. A server component cannot serialise a
// function across that boundary — it throws at render, not at build. These
// take their data as a prop and touch nothing server-only, so the directive
// is the whole fix.
import Link from "next/link"
import { IconFlag, IconMapPin, IconMicrophone2 } from "@tabler/icons-react"

import { Funnel, TrendArea } from "@/components/dashboard/charts"
import { DataTable, type Column } from "@/components/dashboard/data-table"
import { EmptyState, MetricTile, SectionTitle } from "@/components/dashboard/primitives"
import type { AdminOverview, CityRow, OrganiserSupplyRow } from "@/lib/dashboard-types"
import { formatCompact, formatNumber, formatSince } from "@/lib/dashboard-format"

/**
 * Admin overview — attention first, then growth vs vanity, then supply.
 *
 * The attention strip is the top of the page because moderation is the only
 * genuinely time-sensitive thing an admin has, and it was previously reachable
 * only by opening one event's messaging page at a time.
 */
export function OverviewAdmin({ data }: { data: AdminOverview }) {
  const { attention } = data

  const supplyColumns: Column<OrganiserSupplyRow>[] = [
    { key: "name", label: "Organiser", sortType: "string", primary: true },
    { key: "published", label: "Published", align: "right", sortType: "number" },
    { key: "drafts", label: "Drafts", align: "right", secondary: true, sortType: "number" },
    {
      key: "sharePct",
      label: "Share",
      align: "right",
      sortType: "number",
      render: (r) => `${r.sharePct}%`,
    },
    {
      key: "lastEventAt",
      label: "Last event",
      align: "right",
      // Sorting the rendered "31d ago" string puts 31d before 3d. Sort the
      // date; a host who has never run one sorts last either way, which is
      // what you want when hunting for the most recent.
      sortType: "date",
      sortValue: (r) => (r.lastEventAt ? new Date(r.lastEventAt) : null),
      render: (r) => formatSince(r.lastEventAt),
      secondary: true,
    },
  ]

  const cityColumns: Column<CityRow & { id: string }>[] = [
    {
      key: "city",
      label: "City",
      sortType: "string",
      primary: true,
      /*
       * The row links into the curation queue for that city, so the read
       * surface opens the write surface.
       *
       * That is structural rather than tidy. `city_demand` was written on every
       * miss for months and read by nothing, and the way a signal ends up with
       * no reader is that seeing it and acting on it live on different screens.
       */
      render: (row) => (
        <Link
          href={`/dashboard/events/curate?city=${encodeURIComponent(row.city)}`}
          className="hover:underline"
        >
          {row.city}
          {row.launchReady ? (
            <span
              className="ml-2 rounded-full border border-success/40 px-1.5 py-0.5 text-[0.6875rem] text-success"
              title={`${row.waiting} people looking here and nothing to show them`}
            >
              ready
            </span>
          ) : null}
        </Link>
      ),
    },
    {
      key: "waiting",
      label: "Waiting",
      align: "right",
      sortType: "number",
      /*
       * Distinct people who looked here and found nothing. The column this
       * table existed to have and never did — it was built by iterating events,
       * so a city with demand and no events could not appear in it at all.
       */
      render: (row) =>
        row.waiting > 0 ? (
          <b className={row.launchReady ? "font-bold text-success" : "font-bold"}>
            {formatNumber(row.waiting)}
          </b>
        ) : (
          <span className="text-faint-foreground">—</span>
        ),
    },
    { key: "events", label: "Events", align: "right", sortType: "number" },
    { key: "rsvps", label: "RSVPs", align: "right", sortType: "number" },
    { key: "favourites", label: "Saves", align: "right", secondary: true, sortType: "number" },
  ]

  const topThreeShare = data.supply
    .slice(0, 3)
    .reduce((sum, organiser) => sum + organiser.sharePct, 0)

  return (
    <div className="flex flex-col gap-6">
      {attention.pending > 0 ? (
        <Link
          href="/dashboard/moderation"
          className="flex items-center gap-3 rounded-lg border px-4 py-3.5 transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          style={{
            borderColor: "color-mix(in oklab, var(--destructive) 40%, transparent)",
            background: "color-mix(in oklab, var(--destructive) 8%, transparent)",
          }}
        >
          <IconFlag className="size-5 shrink-0 text-destructive" />
          <span className="flex-1 text-sm">
            <b className="font-bold">
              {formatNumber(attention.pending)} flag{attention.pending === 1 ? "" : "s"} pending
              review
            </b>
            {attention.oldestHours !== null ? ` · oldest ${attention.oldestHours}h` : ""}
            {attention.highConfidence > 0
              ? ` · ${attention.highConfidence} high-confidence`
              : ""}
            {attention.affectedRooms > 0
              ? ` · ${attention.affectedRooms} room${attention.affectedRooms === 1 ? "" : "s"}`
              : ""}
          </span>
          <span className="shrink-0 text-sm font-medium text-destructive">Open queue →</span>
        </Link>
      ) : (
        <div className="flex items-center gap-2.5 rounded-lg border border-border px-4 py-2.5 text-[0.8125rem] text-muted-foreground">
          <IconFlag className="size-4 shrink-0" />
          Moderation queue is clear. Flags land here the moment the pipeline or a user report
          raises one.
        </div>
      )}

      {/*
        Deltas are period-over-period, from the range in the URL. These tiles
        rendered bare counts before — the `delta` prop existed on MetricTile and
        nothing ever filled it, so every figure answered "how many" and none
        answered "is that good".

        `hint` falls back to the static descriptor only when there is no delta
        to show, so a tile never carries both a percentage and a label competing
        for the same line.
      */}
      <div className="flex flex-wrap gap-1">
        <MetricTile
          label="Users"
          value={formatCompact(data.users)}
          {...data.deltas.users}
          hint={data.deltas.users.hint ?? "accounts"}
          href="/dashboard/users"
        />
        <MetricTile
          label="Active this week"
          value={formatCompact(data.activeThisWeek.count)}
          /* The hint IS the number's provenance. It read "session proxy"
             unconditionally; it now says which of the two signals produced
             this, because a figure that can come from either has to. */
          hint={data.activeThisWeek.source === "app_opens" ? "opened the app" : "session proxy"}
          href="/dashboard/users"
        />
        <MetricTile
          label="Events published"
          value={formatCompact(data.publishedEvents)}
          {...data.deltas.publishedEvents}
          hint={data.deltas.publishedEvents.hint ?? "all time"}
          href="/dashboard/events"
        />
        {/*
         * "Arrivals", not "Check-ins", because the funnel two panels down has
         * a stage called "checked in" holding a different number — 8 here and
         * 7 there against the same world. Both are right: this counts
         * `event_check_ins` rows in range, the funnel counts distinct people,
         * and one person at two events is two rows.
         *
         * Nothing on the screen said which was which, so a reader who noticed
         * could only conclude that one was broken, and could only find out
         * which by reading the source. Same shape as the two turn-up figures
         * on the event page.
         *
         * Fixed by naming rather than by labelling: a hint cannot carry it,
         * because `deltaHint` displaces the fallback with "new" whenever the
         * previous window was zero — which is exactly when a number is most
         * likely to be read for the first time.
         */}
        <MetricTile
          label="Arrivals"
          value={formatCompact(data.checkIns)}
          {...data.deltas.checkIns}
          hint={data.deltas.checkIns.hint ?? "GPS-validated"}
        />
        <MetricTile
          label="Publishing hosts"
          value={`${data.publishingHosts.publishing} of ${data.publishingHosts.total}`}
          hint="host liquidity"
          href="/dashboard/organisers"
        />
      </div>

      <div className="grid gap-6 @3xl/main:grid-cols-[3fr_2fr]">
        <TrendArea
          title="Signups vs active users"
          hint="8 weeks — the gap is the vanity"
          data={data.growth}
          series={[
            { key: "signups", label: "signups", color: "var(--chart-1)" },
            { key: "active", label: "active", color: "var(--chart-3)" },
          ]}
          empty={data.users === 0}
        />
        <Funnel stages={data.funnel} hint="all time · distinct people" empty={data.users === 0} />
      </div>

      <div className="grid gap-6 @3xl/main:grid-cols-2">
        <div className="flex flex-col gap-3">
          <SectionTitle hint={data.supply.length ? `top 3 hold ${topThreeShare}%` : undefined}>
            Supply by organiser
          </SectionTitle>
          <DataTable
            columns={supplyColumns}
            rows={data.supply}
            sortable
            rowHref={(row) => `/dashboard/organisers/${row.id}`}
            emptyState={
              <EmptyState
                icon={<IconMicrophone2 />}
                title="No organisers publishing yet"
                description="Rows appear as organiser accounts publish events — concentration here is the host-liquidity risk signal."
              />
            }
            footer={
              /*
               * Curated rows are absent from the table above and named here
               * instead, because `organizer_id` on a curated event is the
               * admin who created it — so the organiser-keyed table cannot
               * represent one without attributing our own supply to a founder.
               *
               * Kept to the same line rather than given a tile: it is context
               * for this table, and a reader who sees a total that does not
               * reconcile needs one clause, not a section.
               */
              <span>
                {data.publishingHosts.publishing} of {data.publishingHosts.total} hosts have
                published
                {data.curated.published > 0 &&
                  ` · ${data.curated.published} curated by us, ${data.curated.unclaimed} unclaimed`}
              </span>
            }
          />
        </div>
        <div className="flex flex-col gap-3">
          <SectionTitle>Cities</SectionTitle>
          <DataTable
            columns={cityColumns}
            rows={data.cities.map((city) => ({ ...city, id: city.city }))}
            sortable
            emptyState={
              <EmptyState
                icon={<IconMapPin />}
                title="No city data yet"
                description="Aggregates from each event's city — the expansion signal once volume exists."
              />
            }
            /*
              Hidden with the column it explains.

              `Saves` is `secondary: true`, so `data-table` drops it below the
              container's 2xl — and at 375 this caption sat under a table with
              no Saves column in it, defining a word the reader could not see.
              The same class on both keeps the legend and its column together.
            */
            footer={
              <span className="hidden @2xl/main:inline">saves = demand ahead of RSVP</span>
            }
          />
        </div>
      </div>
    </div>
  )
}
