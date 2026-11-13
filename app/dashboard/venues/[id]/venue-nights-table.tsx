"use client"

import { IconCalendar } from "@tabler/icons-react"

import { DataTable, type Column } from "@/components/dashboard/data-table"
import { EmptyState } from "@/components/dashboard/primitives"
import type { FewCount } from "@/lib/disclosure"
import type { VenueMood, VenueNightRow } from "@/lib/venue-nights"

/**
 * "Nights here" (Venue C, SCRUM-1051, mockup `venue-C-both.png`): one row per
 * night at the venue, the venue's own venue days among them, with what the
 * venue may know of each. Every cell arrives as words or disclosed parts
 * (`lib/venue-nights.ts`); nothing here computes a figure.
 *
 * Split out of the page because these columns carry `render` and `rowHref`
 * functions, which cannot cross the server/client boundary into `DataTable`.
 */

const HOSTS = "host’s"

const columns: Column<VenueNightRow>[] = [
  {
    key: "startAt",
    label: "Night",
    primary: true,
    sortType: "date",
    sortValue: (r) => new Date(r.startAt),
    render: (r) => (
      <span>
        {r.night}
        {/* Its own line on a phone, so the night, who came and met someone fit across one. */}
        {r.venueDay ? (
          <>
            <span className="hidden @2xl/main:inline"> · venue day</span>
            <span className="block text-[0.75rem] text-muted-foreground @2xl/main:hidden">venue day</span>
          </>
        ) : null}
        {r.status === "published" ? null : <span className="text-[0.75rem] text-muted-foreground"> · {r.status}</span>}
      </span>
    ),
  },
  // On a phone: the night, who came and met someone; the host is in "host's", the rest a wider screen away.
  { key: "host", label: "Host", sortType: "string", secondary: true, render: (r) => <span className="text-muted-foreground">{r.host}</span> },
  { key: "came", label: "Came", sortable: false },
  { key: "met", label: "Met someone", sortable: false, render: (r) => (r.met === "hosts" ? HOSTS : r.met) },
  { key: "mood", label: "Mood", sortable: false, secondary: true, render: (r) => <MoodBar mood={r.mood} /> },
  { key: "rating", label: "Rating", sortable: false, secondary: true, render: (r) => r.rating ?? "—" },
  { key: "offers", label: "Offers redeemed", sortable: false, secondary: true, render: (r) => r.offers ?? "—" },
]

const MOODS = [
  { word: "positive", className: "bg-success" },
  { word: "neutral", className: "bg-border-strong" },
  { word: "negative", className: "bg-destructive" },
] as const

/** The width a "few" mood is drawn at: a nominal step, not its count (the count is not sent), as the host's ways bar. */
const FEW_WIDTH = 2

const few = (p: FewCount) => (p === "few" ? "a few" : String(p))

/** The night's mood: the bar from the disclosed parts, and the same in words for a screen reader and on hover. */
function MoodBar({ mood }: { mood: VenueMood | null }) {
  if (!mood) return <span className="text-faint-foreground">—</span>
  // Every mood a few: nominal widths side by side would draw a split nobody measured.
  if (mood.word === "a few messages") return <span className="text-muted-foreground">a few messages</span>
  const widths = mood.parts.map((p) => (p === "few" ? FEW_WIDTH : p))
  const total = widths.reduce((a, b) => a + b, 0)
  const words = `${mood.word}: ${MOODS.map((m, i) => `${few(mood.parts[i])} ${m.word}`).join(", ")}`
  return (
    <span className="inline-flex" title={words}>
      <span className="sr-only">{words}</span>
      <span className="flex h-2 w-[110px] overflow-hidden rounded-full bg-surface-raised" aria-hidden>
        {MOODS.map((m, i) => (
          <span key={m.word} className={m.className} style={{ width: `${(widths[i] / total) * 100}%` }} />
        ))}
      </span>
    </span>
  )
}

export function VenueNightsTable({ rows }: { rows: VenueNightRow[] }) {
  return (
    <DataTable
      columns={columns}
      rows={rows}
      sortable
      defaultSort={{ key: "startAt", dir: "desc" }}
      search
      searchPlaceholder="Search nights by host…"
      pagination
      rowHref={(r) => `/dashboard/events/${r.id}`}
      emptyState={
        <EmptyState
          icon={<IconCalendar />}
          title="No nights in this window"
          description="Nights at this venue, yours and other hosts', appear here. Widen the date range in the top bar to see further back."
        />
      }
    />
  )
}
