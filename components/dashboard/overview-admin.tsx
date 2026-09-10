"use client"

// Client because it hands DataTable `render`/`sortValue` functions, and
// DataTable is a client component. A server component cannot serialise a
// function across that boundary — it throws at render, not at build. These
// take their data as a prop and touch nothing server-only, so the directive
// is the whole fix.
import Link from "next/link"
import { IconMapPin, IconMicrophone2 } from "@tabler/icons-react"

import { AttentionStrip } from "@/components/dashboard/attention-strip"
import { Funnel } from "@/components/dashboard/charts"
import { DataTable, type Column } from "@/components/dashboard/data-table"
import { EmptyState, HeroMetric, SectionTitle } from "@/components/dashboard/primitives"
import type { AdminOverview, CityRow, OrganiserSupplyRow } from "@/lib/dashboard-types"
import { formatCompact, formatNumber, formatSince } from "@/lib/dashboard-format"

/**
 * Admin overview — five panels, derived from what an admin needs answered.
 *
 * ## The board, and what it replaced
 *
 * Nine panels became five, and the order is the order the questions get asked
 * in: is anything waiting on me · is the loop closing · did people turn up ·
 * is there anything to turn up to · where next.
 *
 * Three were cut outright rather than moved.
 *
 *   - **Total users** duplicated the funnel's first stage. Two numbers for one
 *     fact, and the funnel's is the one with context around it.
 *   - **Events published, all time** only goes up. `upcomingEvents` answers the
 *     question somebody actually has.
 *   - **Signups vs active** was cumulative, so it could not show a slowdown —
 *     the single thing a growth chart exists for. See `app/dashboard/actions.ts`.
 *
 * ## One loud thing
 *
 * `DESIGN_SYSTEM.md` allows exactly one `HeroMetric` per screen and the admin
 * overview had none, which is why eleven tiles at identical weight had nowhere
 * for the eye to land. The hero is the last stage of the loop: how many people
 * this product has actually introduced to somebody. It is the only figure here
 * that says whether the thesis holds, and on staging it is zero.
 */
/* Columns are static — hoisted to module scope so the two tables can live in
 * their own panel components without either re-creating them per render. */
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

export function OverviewAdmin({ data }: { data: AdminOverview }) {
  const metStage = data.funnel[data.funnel.length - 1]
  const matched = data.funnel.find((stage) => stage.label.toLowerCase().startsWith("match"))
  const signedUp = data.funnel[0]?.value ?? 0
  const topHost = data.supply[0]

  return (
    <div className="flex flex-col gap-8">
      {/* 1 — is anything waiting on me */}
      <AttentionStrip queues={data.attention} now={new Date(data.generatedAt)} />

      {/* 2 — is the loop closing */}
      <div className="grid gap-6 @3xl/main:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        {/*
          First in DOM, `order-last` inside the container: the hero reads first
          on a narrow column and sits to the right of the bars on a wide one.

          The DOM order is the load-bearing half. A previous version had the
          funnel first and relied on `order-last` doing nothing at wide, which
          looked identical at 1440 and put the headline BELOW the chart at 375 —
          where most of the reading happens on a phone. `order` is a visual
          reordering only; screen readers and tab order follow the DOM, and they
          should reach the hero first too.
        */}
        <HeroMetric
          eyebrow="the loop closes here"
          value={formatNumber(metStage?.value ?? 0)}
          unit={metStage?.value === 1 ? "person" : "people"}
          description={
            metStage && metStage.value === 0
              ? `Nobody has been back for a second event yet${
                  matched && matched.value === 0
                    ? ", and nobody has matched at a first one."
                    : "."
                } Every stage above this is measurable by any events app; these are the ones that need verified attendance, and they are the product.`
              : "Came back for a second event. The only figure here that says the thesis holds — it needs verified physical attendance, so nobody else can compute it."
          }
          className="@3xl/main:order-last"
        />
        <Funnel
          stages={data.funnel}
          /*
            The liveness signal rides here rather than on its own tile.
            Alone it answered nothing; against "signed up" it answers how much
            of that total is a person who still opens the app. The source is
            named because the number can come from two — real app-opens, or the
            refresh-token proxy while `product_events` is still filling — and a
            figure that can come from either has to say which.
          */
          hint={`all time · distinct people · ${formatNumber(
            data.activeThisWeek.count
          )} ${
            data.activeThisWeek.source === "app_opens"
              ? "opened the app in the last 7 days"
              : "held a session in the last 7 days"
          }`}
          empty={signedUp === 0}
        />
      </div>

      {/* 3 and 4 — did they turn up, and is there anything to turn up to */}
      <div className="grid gap-8 @3xl/main:grid-cols-2">
        <TurnUp data={data} />
        <Supply data={data} topHost={topHost} />
      </div>

      {/* 5 — where next */}
      <div className="flex flex-col gap-3">
        <SectionTitle hint="demand against supply">Cities</SectionTitle>
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
          footer={<span className="hidden @2xl/main:inline">saves = demand ahead of RSVP</span>}
        />
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

/**
 * Arrivals, and the people who tried and could not.
 *
 * The two halves are on one panel deliberately. Arrivals alone cannot separate
 * a quiet week from a week where a fence was wrong, and `check_in_refusals` had
 * been recording the difference with no platform-wide reader — so you had to
 * already suspect an event before anything would tell you it was broken.
 */
function TurnUp({ data }: { data: AdminOverview }) {
  const { refusals } = data
  const total = refusals.byReason.reduce((sum, r) => sum + r.people, 0)

  return (
    <section className="flex flex-col gap-3">
      <SectionTitle hint={data.rangeLabel}>Turn-up</SectionTitle>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[length:var(--text-metric)] font-bold leading-tight tabular-nums">
          {formatCompact(data.checkIns)}
        </span>
        <span className="text-[0.8125rem] text-muted-foreground">
          arrivals
          {data.deltas.checkIns.delta !== undefined
            ? ` · ${data.deltas.checkIns.delta > 0 ? "+" : ""}${data.deltas.checkIns.delta}% on the window before`
            : ""}
        </span>
      </div>
      {/*
        "Arrivals", not "Check-ins", because the funnel one panel up has a stage
        called "checked in" holding a different number against the same world.
        Both are right — this counts rows in the window, the funnel counts
        distinct people, and one person at two events is two rows. Nothing said
        which was which, so a reader who noticed could only conclude one was
        broken.
      */}
      <p className="text-[0.8125rem] text-muted-foreground">
        Arrivals are check-in rows; the loop counts people, so one person at two
        events differs between them.
      </p>

      {refusals.total === 0 ? (
        <p className="text-[0.8125rem] text-faint-foreground">
          Nobody was turned away at a door this window.
        </p>
      ) : (
        <div className="flex flex-col gap-2.5 pt-1">
          <div className="flex items-baseline justify-between gap-3 text-[0.8125rem]">
            <span className="font-medium">
              {formatNumber(refusals.total)} turned away
            </span>
            <span className="text-muted-foreground">the other half of the door</span>
          </div>
          <div
            className="flex h-2 overflow-hidden rounded-full"
            role="img"
            aria-label={`${refusals.total} people turned away: ${refusals.byReason
              .map((r) => `${r.people} ${r.label.toLowerCase()}`)
              .join(", ")}`}
          >
            {refusals.byReason.map((row, index) => (
              <span
                key={row.reason}
                style={{
                  width: `${(row.people / total) * 100}%`,
                  background: `var(--chart-${(index % 5) + 1})`,
                }}
              />
            ))}
          </div>
          <ul className="flex flex-col gap-1.5">
            {refusals.byReason.map((row, index) => (
              <li key={row.reason} className="flex items-center gap-2.5 text-[0.8125rem]">
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-[2px]"
                  style={{ background: `var(--chart-${(index % 5) + 1})` }}
                />
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{row.label}</span>
                <span className="font-medium tabular-nums">{formatNumber(row.people)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}

/* -------------------------------------------------------------------------- */

/** Is there anything to send people to, and how much of it rests on one host. */
function Supply({ data, topHost }: { data: AdminOverview; topHost?: OrganiserSupplyRow }) {
  const { publishing, total } = data.publishingHosts

  return (
    <section className="flex flex-col gap-3">
      <SectionTitle hint="forward-looking">Supply</SectionTitle>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[length:var(--text-metric)] font-bold leading-tight tabular-nums">
          {formatCompact(data.upcomingEvents)}
        </span>
        <span className="text-[0.8125rem] text-muted-foreground">
          events still to come
          {data.curated.published > 0
            ? ` · ${formatNumber(data.curated.unclaimed)} of ours unclaimed`
            : ""}
        </span>
      </div>

      <div className="flex flex-col gap-4 pt-1">
        <Meter
          label="Hosts publishing"
          value={`${formatNumber(publishing)} of ${formatNumber(total)}`}
          pct={total === 0 ? 0 : (publishing / total) * 100}
          colour="var(--chart-1)"
        />
        {/*
          Concentration, not a leaderboard. One host holding half of what is
          coming is the host-liquidity risk in a single number, and it is the
          reason this panel is not just a count of events.
        */}
        <Meter
          label={topHost ? `Busiest host · ${topHost.name}` : "Busiest host"}
          value={topHost ? `${topHost.sharePct}%` : "—"}
          pct={topHost?.sharePct ?? 0}
          colour="var(--chart-3)"
        />
      </div>

      <div className="flex flex-col gap-3 pt-2">
        <SectionTitle
          hint={data.supply.length ? `${data.supply.length} publishing` : undefined}
        >
          By organiser
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
        />
      </div>
    </section>
  )
}

function Meter({
  label,
  value,
  pct,
  colour,
}: {
  label: string
  value: string
  pct: number
  colour: string
}) {
  const clamped = Math.max(0, Math.min(100, pct))
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-[0.8125rem]">
        <span className="min-w-0 truncate text-muted-foreground">{label}</span>
        <span className="shrink-0 font-medium tabular-nums">{value}</span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={Math.round(clamped)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
        className="h-1.5 overflow-hidden rounded-full bg-surface-raised"
      >
        <div className="h-full rounded-full" style={{ width: `${clamped}%`, background: colour }} />
      </div>
    </div>
  )
}
