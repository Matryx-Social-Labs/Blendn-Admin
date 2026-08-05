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
    { key: "name", label: "Organiser" },
    { key: "published", label: "Published", align: "right" },
    { key: "drafts", label: "Drafts", align: "right", secondary: true },
    { key: "sharePct", label: "Share", align: "right", render: (r) => `${r.sharePct}%` },
    {
      key: "lastEventAt",
      label: "Last event",
      align: "right",
      render: (r) => formatSince(r.lastEventAt),
      secondary: true,
    },
  ]

  const cityColumns: Column<CityRow & { id: string }>[] = [
    { key: "city", label: "City" },
    { key: "events", label: "Events", align: "right" },
    { key: "rsvps", label: "RSVPs", align: "right" },
    { key: "favourites", label: "Saves", align: "right", secondary: true },
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

      <div className="flex flex-wrap gap-1">
        <MetricTile label="Users" value={formatCompact(data.users)} hint="accounts" href="/dashboard/users" />
        <MetricTile
          label="Active this week"
          value={formatCompact(data.activeThisWeek)}
          hint="session proxy"
          href="/dashboard/users"
        />
        <MetricTile
          label="Events published"
          value={formatCompact(data.publishedEvents)}
          hint="all time"
          href="/dashboard/events"
        />
        <MetricTile
          label="Check-ins"
          value={formatCompact(data.checkIns)}
          hint="GPS-validated"
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
        <Funnel stages={data.funnel} empty={data.users === 0} />
      </div>

      <div className="grid gap-6 @3xl/main:grid-cols-2">
        <div className="flex flex-col gap-3">
          <SectionTitle hint={data.supply.length ? `top 3 hold ${topThreeShare}%` : undefined}>
            Supply by organiser
          </SectionTitle>
          <DataTable
            columns={supplyColumns}
            rows={data.supply}
            rowHref={(row) => `/dashboard/organisers/${row.id}`}
            emptyState={
              <EmptyState
                icon={<IconMicrophone2 />}
                title="No organisers publishing yet"
                description="Rows appear as organiser accounts publish events — concentration here is the host-liquidity risk signal."
              />
            }
            footer={
              <span>
                {data.publishingHosts.publishing} of {data.publishingHosts.total} hosts have
                published
              </span>
            }
          />
        </div>
        <div className="flex flex-col gap-3">
          <SectionTitle>Cities</SectionTitle>
          <DataTable
            columns={cityColumns}
            rows={data.cities.map((city) => ({ ...city, id: city.city }))}
            emptyState={
              <EmptyState
                icon={<IconMapPin />}
                title="No city data yet"
                description="Aggregates from each event's city — the expansion signal once volume exists."
              />
            }
            footer={<span>saves = demand ahead of RSVP</span>}
          />
        </div>
      </div>
    </div>
  )
}
