import { PacingChart } from "@/components/dashboard/charts"
import { Panel } from "@/components/dashboard/kit"
import type { CohortRow, ComparisonRow, EventAnalytics, OrgAnalytics } from "@/lib/org-analytics"

/**
 * The paid Analytics views, drawn from props alone.
 *
 * The same components draw the organisation's figures when it may see them
 * and `lib/sample-analytics.ts` behind a `Locked` blur when it may not. They
 * import types from the query module and nothing else from it, so a preview
 * can only ever be given the sample (`previews-use-sample-data.test.ts`).
 *
 * `null` is a figure held back under the privacy floor, and says so in the
 * cell where the number would be: the floor is a rule the reader can see, not
 * a gap that looks like missing data (the screen's memorable detail).
 */

const DAY = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" })
const MONTH = new Intl.DateTimeFormat("en-IN", { month: "short", year: "numeric", timeZone: "UTC" })
const TIME = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" })

function HeldBack() {
  return <span className="text-[0.75rem] text-faint-foreground">held back</span>
}

const pctOrHeld = (v: number | null) => (v === null ? <HeldBack /> : `${v}%`)

export function minutes(total: number): string {
  const h = Math.floor(total / 60)
  const m = total % 60
  return h === 0 ? `${m}m` : `${h}h ${String(m).padStart(2, "0")}m`
}

/* -------------------------------------------------------------------------- */

export function ComparisonTable({ rows }: { rows: ComparisonRow[] }) {
  return (
    <Panel title="Every event side by side" hint='past events in range · turn-up against "going"'>
      {rows.length === 0 ? (
        <p className="text-[0.8125rem] text-muted-foreground">No event has ended in this range yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-[0.8125rem]">
            <thead>
              <tr className="text-left text-[0.75rem] text-faint-foreground">
                <th className="pb-2 font-medium">Event</th>
                <th className="pb-2 text-right font-medium">Going</th>
                <th className="pb-2 text-right font-medium">Came</th>
                <th className="pb-2 text-right font-medium">Turn-up</th>
                <th className="pb-2 text-right font-medium">First-time</th>
                <th className="pb-2 text-right font-medium">Median stay</th>
                <th className="pb-2 text-right font-medium">Rating</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {rows.map((r) => (
                <tr key={r.eventId} className="border-t border-border">
                  <td className="py-2 pr-3">
                    {r.title} <span className="text-muted-foreground">· {DAY.format(new Date(r.startsAt))}</span>
                  </td>
                  <td className="py-2 text-right">{r.going}</td>
                  <td className="py-2 text-right">{r.came}</td>
                  <td className="py-2 text-right">{r.turnUpPct === null ? "—" : `${r.turnUpPct}%`}</td>
                  <td className="py-2 text-right">{pctOrHeld(r.firstTimePct)}</td>
                  <td className="py-2 text-right">{r.medianStayMin === null ? <HeldBack /> : minutes(r.medianStayMin)}</td>
                  <td className="py-2 text-right">{r.rating === null ? <HeldBack /> : r.rating.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}

function CohortCell({ value }: { value: number | null | "open" }) {
  if (value === "open") return <span className="text-[0.75rem] italic text-faint-foreground">still open</span>
  return <>{pctOrHeld(value)}</>
}

export function CohortGrid({ rows }: { rows: CohortRow[] }) {
  return (
    <Panel title="Did first-timers come back" hint="by month of their first event here">
      {rows.length === 0 ? (
        <p className="text-[0.8125rem] text-muted-foreground">Nobody had a first event here in this range.</p>
      ) : (
        <table className="w-full text-[0.8125rem]">
          <thead>
            <tr className="text-left text-[0.75rem] text-faint-foreground">
              <th className="pb-2 font-medium">First event</th>
              <th className="pb-2 text-right font-medium">People</th>
              <th className="pb-2 text-right font-medium">30 days</th>
              <th className="pb-2 text-right font-medium">60 days</th>
              <th className="pb-2 text-right font-medium">90 days</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {rows.map((r) => (
              <tr key={r.month} className="border-t border-border">
                <td className="py-2">{MONTH.format(new Date(`${r.month}-01T00:00:00Z`))}</td>
                <td className="py-2 text-right">{r.people === null ? <HeldBack /> : r.people}</td>
                <td className="py-2 text-right"><CohortCell value={r.back.d30} /></td>
                <td className="py-2 text-right"><CohortCell value={r.back.d60} /></td>
                <td className="py-2 text-right"><CohortCell value={r.back.d90} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  )
}

export function PacingAgainstMedian({ pacing }: { pacing: OrgAnalytics["pacing"] }) {
  if (!pacing) {
    return (
      <Panel title="Pacing against your median">
        <p className="text-[0.8125rem] text-muted-foreground">
          Appears once you have an upcoming event and at least two that have run.
        </p>
      </Panel>
    )
  }
  return (
    <PacingChart
      points={pacing.points}
      capacity={pacing.capacity}
      windowDays={pacing.windowDays}
      benchmark={{ title: "median", points: pacing.median }}
      benchmarkHint={`${pacing.title} · grey is the median of your last ${pacing.basedOn}`}
    />
  )
}

/** The three cross-event views, for the real figures or the sample. */
export function OrgPanels({ data }: { data: OrgAnalytics }) {
  return (
    <div className="flex flex-col gap-5">
      <ComparisonTable rows={data.comparison} />
      <div className="grid grid-cols-1 gap-5 @4xl/main:grid-cols-2">
        <CohortGrid rows={data.cohorts} />
        <PacingAgainstMedian pacing={data.pacing} />
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function Stat({ label, value, note }: { label: string; value: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div className="flex min-w-[140px] flex-col gap-0.5">
      <span className="text-[0.75rem] font-medium uppercase tracking-[0.06em] text-muted-foreground">{label}</span>
      <span className="text-[1.375rem] font-bold tabular-nums">{value}</span>
      {note ? <span className="text-[0.75rem] text-faint-foreground">{note}</span> : null}
    </div>
  )
}

export function ArrivalBars({ arrivals }: { arrivals: EventAnalytics["arrivals"] }) {
  if (arrivals.length === 0) {
    return <p className="text-[0.8125rem] text-muted-foreground">No arrival was recorded for this event.</p>
  }
  const peak = Math.max(...arrivals.map((a) => a.people ?? 0), 5)
  return (
    <figure className="flex flex-col gap-1.5">
      <figcaption className="text-[0.75rem] font-medium uppercase tracking-[0.06em] text-muted-foreground">
        Arrivals, every 10 minutes
      </figcaption>
      <div className="flex h-[120px] items-end gap-1 border-b border-chart-grid">
        {arrivals.map((a) =>
          a.people === null ? (
            <div
              key={a.at}
              title={`${TIME.format(new Date(a.at))}: fewer than 5, held back`}
              className="h-2.5 flex-1 rounded-t border border-dashed border-border-strong"
            />
          ) : (
            <div
              key={a.at}
              title={`${TIME.format(new Date(a.at))}: ${a.people}`}
              className="flex-1 rounded-t bg-chart-1"
              style={{ height: `${Math.max(4, (a.people / peak) * 100)}%` }}
            />
          )
        )}
      </div>
      <div className="flex justify-between text-[0.6875rem] text-faint-foreground">
        <span>{TIME.format(new Date(arrivals[0].at))}</span>
        <span>dashed: fewer than 5, held back</span>
        <span>{TIME.format(new Date(arrivals[arrivals.length - 1].at))}</span>
      </div>
    </figure>
  )
}

/** One event's pass features, for the real figures or the sample. */
export function EventPassPanels({ data }: { data: EventAnalytics }) {
  const { stay, funnel } = data
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap gap-x-8 gap-y-4">
        <Stat
          label="Median stay"
          value={stay ? minutes(stay.p50Min) : <HeldBack />}
          note={stay ? `middle half ${minutes(stay.p25Min)} – ${minutes(stay.p75Min)}` : "fewer than 5 people's stays"}
        />
        <Stat
          label="Left early"
          value={stay ? pctOrHeld(stay.leftEarlyPct) : <HeldBack />}
          note="over 30 minutes before the end"
        />
        <Stat
          label="First-time"
          value={data.firstTimers === null ? <HeldBack /> : data.firstTimers}
          note={data.returning === null ? "returning held back" : `${data.returning} returning`}
        />
        <Stat
          label="App views → RSVPs"
          value={pctOrHeld(funnel.conversionPct)}
          note={
            funnel.viewers === null
              ? "fewer than 5 people looked · app views only"
              : `${funnel.viewersWhoRsvpd ?? "<5"} of ${funnel.viewers} who looked · app views only`
          }
        />
      </div>
      {stay && stay.softPct !== null ? (
        <p className="text-[0.75rem] text-faint-foreground">
          {stay.softPct}% of stays ended when their phone went quiet rather than at a check-out, so those are estimates.
        </p>
      ) : null}
      <ArrivalBars arrivals={data.arrivals} />
    </div>
  )
}
