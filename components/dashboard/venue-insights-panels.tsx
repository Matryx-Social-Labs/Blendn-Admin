import type { PeopleGrid, PreClaimHistory, VenueInsight } from "@/lib/venue-insights"
import { formatNumber } from "@/lib/dashboard-format"

/**
 * A venue's insights, drawn from what they are given and nothing else: the
 * venue's own figures on the venue page, or `lib/sample-analytics.ts` inside a
 * `Locked` preview. The query module is imported for its types only
 * (`__tests__/previews-use-sample-data.test.ts`), so these cannot fetch.
 *
 * A held-back cell (fewer than 5 people) is drawn as "<5", never a number and
 * never zero: a quiet slot and a small one are different claims.
 */

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
const SLOTS = ["morn", "aft", "eve", "late"]
const SLOT_NAMES = ["morning", "afternoon", "evening", "late"]

/** Distinct guests by day and slot, on the venue's clock. */
export function PeopleHeatmap({ people }: { people: PeopleGrid }) {
  const max = Math.max(1, ...people.flat().map((n) => n ?? 0))
  return (
    <div className="grid grid-cols-[38px_repeat(7,1fr)] gap-1 text-[0.6875rem] text-muted-foreground">
      <span />
      {DAYS.map((d) => (
        <span key={d} className="text-center">
          {d}
        </span>
      ))}
      {SLOTS.map((slot, si) => (
        <div key={slot} className="contents">
          <span className="self-center">{slot}</span>
          {DAYS.map((day, di) => {
            // null is a held-back cell (1–4 people), never 0: only a missing cell is empty.
            const cell = people[di]?.[si]
            const n = cell === undefined ? 0 : cell
            return (
              <div
                key={day}
                title={`${day} ${SLOT_NAMES[si]}: ${n === null ? "fewer than 5 people" : `${n} ${n === 1 ? "person" : "people"}`}`}
                className="flex h-7 items-center justify-center rounded tabular-nums"
                style={{
                  background:
                    n === null
                      ? "color-mix(in oklch, var(--chart-1) 14%, transparent)"
                      : n === 0
                        ? "var(--surface-raised)"
                        : `color-mix(in oklch, var(--chart-1) ${Math.round(18 + 70 * (n / max))}%, transparent)`,
                  color: n !== null && n / max > 0.55 ? "var(--foreground)" : undefined,
                }}
              >
                {n === null ? "<5" : n === 0 ? "" : n}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

/** Guests, regulars and the returning share, each held back on its own terms. */
export function RegularsFigures({ regulars }: { regulars: VenueInsight["regulars"] }) {
  const items = [
    // Counted in the slots the grid shows, so the total never gives a held one back.
    { label: "Guests", value: regulars.visitors, hint: "in the slots shown" },
    { label: "Regulars", value: regulars.regulars, hint: "came on 2+ nights" },
    { label: "Returning share", value: regulars.sharePct === null ? null : `${regulars.sharePct}%`, hint: "of guests" },
  ]
  return (
    <dl className="grid grid-cols-3 gap-3">
      {items.map((item) => (
        <div key={item.label} className="flex flex-col gap-0.5">
          <dt className="text-[0.75rem] font-medium uppercase tracking-[0.06em] text-muted-foreground">{item.label}</dt>
          <dd className="text-[1.375rem] font-bold tabular-nums">
            {item.value === null ? "—" : typeof item.value === "number" ? formatNumber(item.value) : item.value}
          </dd>
          <dd className="text-[0.75rem] text-faint-foreground">{item.value === null ? "fewer than 5 in a group" : item.hint}</dd>
        </div>
      ))}
    </dl>
  )
}

/** The whole insight, as a block: the grid, then the figures. */
export function VenueInsightBody({ insight }: { insight: VenueInsight }) {
  return (
    <div className="flex flex-col gap-4">
      <PeopleHeatmap people={insight.people} />
      <RegularsFigures regulars={insight.regulars} />
    </div>
  )
}

const MONTH = new Intl.DateTimeFormat("en-IN", { month: "short", year: "numeric", timeZone: "UTC" })

/** The nights before the claim, as three totals: never a night, never a person. */
export function PreClaimFigures({ history }: { history: PreClaimHistory }) {
  const since = history.since ? MONTH.format(new Date(`${history.since}-01T00:00:00Z`)) : null
  return (
    <dl className="grid grid-cols-3 gap-3">
      <div className="flex flex-col gap-0.5">
        <dt className="text-[0.75rem] font-medium uppercase tracking-[0.06em] text-muted-foreground">Nights</dt>
        <dd className="text-[1.375rem] font-bold tabular-nums">{history.nights === null ? "—" : formatNumber(history.nights)}</dd>
      </div>
      <div className="flex flex-col gap-0.5">
        <dt className="text-[0.75rem] font-medium uppercase tracking-[0.06em] text-muted-foreground">Guests</dt>
        <dd className="text-[1.375rem] font-bold tabular-nums">{history.people === null ? "—" : formatNumber(history.people)}</dd>
        {history.people === null ? <dd className="text-[0.75rem] text-faint-foreground">fewer than 5</dd> : null}
      </div>
      <div className="flex flex-col gap-0.5">
        <dt className="text-[0.75rem] font-medium uppercase tracking-[0.06em] text-muted-foreground">Since</dt>
        <dd className="text-[1.375rem] font-bold">{since ?? "—"}</dd>
      </div>
    </dl>
  )
}

/** The regulars & offers composer's report, for its placeholder (step 12 wires the real one). */
export function OfferPreview({
  offer,
}: {
  offer: { offer: string; audience: string; sent: number; opened: number; redeemed: number }
}) {
  return (
    <div className="flex flex-col gap-3 p-5">
      <p className="text-[0.875rem] font-bold">{offer.offer}</p>
      <p className="text-[0.75rem] text-muted-foreground">{offer.audience}</p>
      <dl className="grid grid-cols-3 gap-3">
        {(["sent", "opened", "redeemed"] as const).map((k) => (
          <div key={k} className="flex flex-col gap-0.5">
            <dt className="text-[0.75rem] uppercase tracking-[0.06em] text-muted-foreground">{k}</dt>
            <dd className="text-[1.375rem] font-bold tabular-nums">{offer[k]}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/** What Venue Pro adds, as one block for a `Locked` preview: a year's insight and the pre-claim totals. */
export function VenueProSample({ insight, history }: { insight: VenueInsight; history: PreClaimHistory }) {
  return (
    <div className="flex flex-col gap-4 p-5">
      <VenueInsightBody insight={insight} />
      <PreClaimFigures history={history} />
    </div>
  )
}
