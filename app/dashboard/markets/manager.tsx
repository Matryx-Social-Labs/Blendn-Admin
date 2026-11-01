"use client"

import Link from "next/link"
import { useState, useTransition } from "react"
import { toast } from "sonner"

import { Panel, StatLine } from "@/components/dashboard/kit"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { LaunchState } from "@/lib/cities"
import { addPreviewer, removePreviewer, setCityState, setMarketState, type CityView, type MarketView } from "@/lib/market-actions"
import { refusalMessage } from "@/lib/refusal"
import { cn } from "@/lib/utils"

import { AddForms } from "./forms"

/*
 * The design chain's memorable detail: a market's state is a ceiling over every
 * city's Hidden · Preview · Live ladder. A segment above the cap is dashed (the
 * setting is kept, its effect capped), and Live on an empty city is struck
 * through, its "0 upcoming · 0 venues" the reason. Confirms are inline, in the
 * row, and name the consequence before anything is written.
 */

const RANK: Record<LaunchState, number> = { hidden: 0, preview: 1, live: 2 }
const LABEL: Record<LaunchState, string> = { hidden: "Hidden", preview: "Preview", live: "Live" }
const DOT: Record<LaunchState, string> = { hidden: "bg-faint-foreground", preview: "bg-warning", live: "bg-success" }
const CITIES_SHOWN = 12
const PREVIEWERS_SHOWN = 10
const SOON = "within about a minute"

type Pending = { kind: "market"; code: string; to: LaunchState } | { kind: "city"; slug: string; to: LaunchState }

const isEmpty = (c: CityView) => c.upcomingEvents === 0 && c.venues === 0
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function cityConsequence(city: CityView, market: MarketView, to: LaunchState): string {
  if (to === "hidden") return `${city.name} disappears from the app ${SOON}. Nobody sees it, previewers included.`
  if (to === "preview") return `${city.name} shows as Coming soon to everyone ${SOON}; only ${market.name}’s previewers can open it.`
  if (market.launchState === "preview") {
    return `${city.name} is set to Live, but ${market.name} is in preview, so it still shows as Coming soon, fully only to ${market.name}’s previewers, until ${market.name} goes live.`
  }
  if (market.launchState === "hidden") return `${city.name} is set to Live, but ${market.name} is hidden, so nobody sees it until ${market.name} is live.`
  return `${city.name} becomes visible to everyone in the app ${SOON}. Its ${plural(city.upcomingEvents, "upcoming event")} and ${plural(city.venues, "venue")} start showing.`
}

function marketConsequence(market: MarketView, to: LaunchState): string {
  if (to === "live") {
    const live = market.cities.filter((c) => c.launchState === "live").length
    return `${market.name} goes live: its ${plural(live, "live city", "live cities")} become visible to everyone ${SOON}. Preview cities stay Coming soon.`
  }
  if (to === "preview") return `${market.name} turns into Coming soon for everyone ${SOON}. Only its ${plural(market.previewerCount, "previewer")} see its cities fully.`
  return `${market.name} and its ${plural(market.cities.length, "city", "cities")} disappear from the app ${SOON}. Nobody sees them, previewers included.`
}

function Ladder({
  label,
  value,
  cap,
  refusedLive,
  describedBy,
  disabled,
  onPick,
}: {
  label: string
  value: LaunchState
  cap?: LaunchState
  refusedLive?: boolean
  describedBy?: string
  disabled: boolean
  onPick: (to: LaunchState) => void
}) {
  return (
    <div role="radiogroup" aria-label={label} aria-describedby={describedBy} className="inline-flex flex-none gap-0.5 rounded-md border border-input p-0.5">
      {(["hidden", "preview", "live"] as const).map((state) => {
        const refused = state === "live" && refusedLive && value !== "live"
        return (
          <button
            key={state}
            type="button"
            role="radio"
            aria-checked={value === state}
            aria-disabled={refused || undefined}
            disabled={disabled}
            onClick={() => (refused || value === state ? undefined : onPick(state))}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-[6px] border border-transparent px-2.5 text-[0.8125rem] text-muted-foreground",
              value === state && "bg-accent font-bold text-foreground",
              cap && RANK[state] > RANK[cap] && "border-dashed border-faint-foreground/60",
              refused && "cursor-not-allowed text-faint-foreground line-through"
            )}
          >
            <span aria-hidden className={cn("size-[7px] rounded-full", DOT[state])} />
            {LABEL[state]}
          </button>
        )
      })}
    </div>
  )
}

function Confirm({ text, verb, destructive, pending, onYes, onNo }: { text: string; verb: string; destructive: boolean; pending: boolean; onYes: () => void; onNo: () => void }) {
  return (
    <div role="alert" className="flex basis-full flex-wrap items-center gap-x-3 gap-y-2 rounded-md bg-accent/45 px-3 py-2.5">
      <p className="min-w-[17rem] flex-1 text-[0.8125rem]">{text}</p>
      <Button size="sm" variant={destructive ? "destructive" : "default"} disabled={pending} onClick={onYes}>
        {verb}
      </Button>
      <Button size="sm" variant="ghost" disabled={pending} onClick={onNo}>
        Cancel
      </Button>
    </div>
  )
}

const verbFor = (name: string, to: LaunchState) => (to === "live" ? `Make ${name} live` : to === "preview" ? "Set to preview" : `Hide ${name}`)

export function MarketsManager({ markets }: { markets: MarketView[] }) {
  const [busy, startTransition] = useTransition()
  const [pending, setPending] = useState<Pending | null>(null)

  const run = (fn: () => Promise<void>, ok: string, after?: () => void) =>
    startTransition(async () => {
      try {
        await fn()
        toast.success(ok)
        setPending(null)
        after?.()
      } catch (err) {
        toast.error(refusalMessage(err, "That did not work"))
      }
    })

  const cities = markets.flatMap((m) => m.cities)
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <StatLine
          items={[
            { value: markets.length, label: markets.length === 1 ? "country" : "countries" },
            { value: markets.filter((m) => m.launchState === "live").length, label: "live" },
            { value: cities.filter((c) => c.effectiveState === "live").length, label: "cities live to everyone" },
            { value: cities.filter((c) => c.effectiveState === "preview").length, label: "in preview" },
            { value: cities.filter((c) => c.effectiveState === "hidden").length, label: "hidden", tone: "faint" },
          ]}
        />
        <Link href="/dashboard/audit" className="text-[0.8125rem] text-muted-foreground underline-offset-4 hover:underline">
          What changed: audit log
        </Link>
      </div>

      {markets.map((market) => (
        <div key={market.code} className="flex flex-col gap-5">
          <MarketPanel market={market} pending={pending} busy={busy} onPending={setPending} run={run} />
          {market.launchState !== "live" ? <PreviewersPanel market={market} busy={busy} run={run} /> : null}
        </div>
      ))}

      <AddForms markets={markets} />
    </div>
  )
}

type Run = (fn: () => Promise<void>, ok: string, after?: () => void) => void

function MarketPanel({ market, pending, busy, onPending, run }: { market: MarketView; pending: Pending | null; busy: boolean; onPending: (p: Pending | null) => void; run: Run }) {
  const [filter, setFilter] = useState("")
  const [all, setAll] = useState(false)
  const capped = market.cities.some((c) => RANK[c.launchState] > RANK[market.launchState])
  const ordered = [...market.cities].sort((a, b) => RANK[b.launchState] - RANK[a.launchState] || Number(b.isDefault) - Number(a.isDefault))
  const matching = ordered.filter((c) => !filter || `${c.name} ${c.slug}`.toLowerCase().includes(filter.toLowerCase()))
  const shown = all || filter ? matching : matching.slice(0, CITIES_SHOWN)
  const marketPending = pending?.kind === "market" && pending.code === market.code ? pending : null

  return (
    <Panel
      title={market.name}
      hint={
        <>
          <span className="font-mono">{`${market.code} · ${market.currency} · ${market.locale}`}</span>
          {` · ${plural(market.cities.length, "city", "cities")}`}
          {capped ? ` · capped at ${LABEL[market.launchState]}` : ""}
        </>
      }
      action={
        <Ladder
          label={`${market.name} launch state`}
          value={market.launchState}
          disabled={busy}
          onPick={(to) => onPending({ kind: "market", code: market.code, to })}
        />
      }
      bodyClassName="gap-0 px-5 pb-2 pt-1"
    >
      {marketPending ? (
        <div className="py-2">
          <Confirm
            text={marketConsequence(market, marketPending.to)}
            verb={marketPending.to === "live" ? `Make ${market.name} live` : marketPending.to === "preview" ? "Set to preview" : `Hide ${market.name}`}
            destructive={marketPending.to === "hidden"}
            pending={busy}
            onYes={() => run(() => setMarketState(market.code, marketPending.to), `${market.name}: ${LABEL[marketPending.to]}`)}
            onNo={() => onPending(null)}
          />
        </div>
      ) : null}
      {market.cities.length > CITIES_SHOWN ? (
        <Input aria-label={`Filter ${market.name}’s cities`} placeholder="Filter cities" value={filter} onChange={(e) => setFilter(e.target.value)} className="my-2 max-w-xs" />
      ) : null}
      {market.cities.length === 0 ? <p className="py-3 text-[0.8125rem] text-muted-foreground">No cities in {market.name} yet. Add one below; it starts hidden.</p> : null}
      {shown.map((city) => (
        <CityRow key={city.slug} city={city} market={market} pending={pending} busy={busy} onPending={onPending} run={run} />
      ))}
      {!all && !filter && matching.length > CITIES_SHOWN ? (
        <Button variant="ghost" size="sm" className="my-2 self-start" onClick={() => setAll(true)}>
          Show all {matching.length} cities
        </Button>
      ) : null}
    </Panel>
  )
}

function CityRow({ city, market, pending, busy, onPending, run }: { city: CityView; market: MarketView; pending: Pending | null; busy: boolean; onPending: (p: Pending | null) => void; run: Run }) {
  const empty = isEmpty(city)
  const mine = pending?.kind === "city" && pending.slug === city.slug ? pending : null
  const noteId = `city-note-${city.slug}`
  const capped = RANK[city.launchState] > RANK[market.launchState]
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-border py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-semibold">{city.name}</span>
          {city.isDefault ? <span className="text-[0.75rem] text-faint-foreground">default</span> : null}
        </div>
        <div className="flex flex-wrap gap-x-2.5 text-[0.75rem] text-muted-foreground">
          <span className="font-mono">{city.slug}</span>
          {city.region ? <span>{city.region}</span> : null}
          <span className="font-mono">{city.timezone}</span>
          {city.licensedMinAge ? <span>{city.licensedMinAge}+ at licensed venues</span> : null}
        </div>
      </div>
      <div className={cn("w-48 flex-none whitespace-nowrap text-[0.78125rem] tabular-nums text-muted-foreground", empty && "font-medium text-warning")}>
        <b className={cn("font-bold", !empty && "text-foreground")}>{city.upcomingEvents}</b> upcoming · <b className={cn("font-bold", !empty && "text-foreground")}>{city.venues}</b> venues
      </div>
      <Ladder
        label={`${city.name} launch state`}
        value={city.launchState}
        cap={market.launchState}
        refusedLive={empty}
        describedBy={empty || capped ? noteId : undefined}
        disabled={busy}
        onPick={(to) => onPending({ kind: "city", slug: city.slug, to })}
      />
      {empty && city.launchState !== "live" ? (
        <p id={noteId} className="basis-full text-[0.78125rem] text-warning">
          {city.name} can&rsquo;t go live: it has no upcoming listed events and no listed venues. List an event or a venue in {city.name} first.
        </p>
      ) : capped ? (
        <p id={noteId} className="basis-full text-[0.78125rem] text-faint-foreground">
          Set to {LABEL[city.launchState]} · shows as {LABEL[market.launchState]} while {market.name} is {market.launchState === "preview" ? "in preview" : "hidden"}
        </p>
      ) : null}
      {mine ? (
        <Confirm
          text={cityConsequence(city, market, mine.to)}
          verb={verbFor(city.name, mine.to)}
          destructive={mine.to === "hidden"}
          pending={busy}
          onYes={() => run(() => setCityState(city.slug, mine.to), `${city.name}: ${LABEL[mine.to]}`)}
          onNo={() => onPending(null)}
        />
      ) : null}
    </div>
  )
}

function PreviewersPanel({ market, busy, run }: { market: MarketView; busy: boolean; run: Run }) {
  const [email, setEmail] = useState("")
  const [query, setQuery] = useState("")
  const [all, setAll] = useState(false)
  const q = query.trim().toLowerCase()
  const matching = market.previewers.filter((p) => !q || `${p.email} ${p.name ?? ""}`.toLowerCase().includes(q))
  const shown = all || q ? matching : matching.slice(0, PREVIEWERS_SHOWN)
  const hint = market.launchState === "preview" ? `see ${market.name}’s cities fully while it is in preview` : `see nothing while ${market.name} is hidden`

  return (
    <Panel title={`${market.name} previewers`} hint={`${hint} · ${market.previewerCount}`} bodyClassName="gap-0 px-5 pb-2 pt-1">
      <form
        className="flex flex-wrap items-center gap-2 py-2"
        onSubmit={(e) => {
          e.preventDefault()
          const address = email.trim()
          if (address) run(() => addPreviewer(market.code, address), `${address} can now see ${market.name} in preview.`, () => setEmail(""))
        }}
      >
        <Input type="email" required aria-label={`Email of a new ${market.name} previewer`} placeholder="name@example.com" value={email} onChange={(e) => setEmail(e.target.value)} className="max-w-xs" />
        <Button type="submit" variant="outline" size="sm" disabled={busy}>
          Add previewer
        </Button>
        {market.previewerCount > PREVIEWERS_SHOWN ? (
          <Input aria-label={`Search ${market.name}’s previewers`} placeholder="Search previewers" value={query} onChange={(e) => setQuery(e.target.value)} className="ml-auto max-w-xs" />
        ) : null}
      </form>
      {market.previewerCount === 0 ? <p className="py-3 text-[0.8125rem] text-muted-foreground">Nobody previews {market.name} yet.</p> : null}
      {q && matching.length === 0 ? <p className="py-3 text-[0.8125rem] text-muted-foreground">No previewer matches &ldquo;{query.trim()}&rdquo;.</p> : null}
      {shown.map((p) => (
        <div key={p.userId} className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border py-2.5 last:border-b-0">
          <span className="min-w-0 flex-1 truncate">{p.email}</span>
          <span className="text-[0.8125rem] text-muted-foreground">{p.name ?? ""}</span>
          <span className="whitespace-nowrap text-[0.75rem] text-faint-foreground">
            added {new Date(p.addedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
          </span>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => run(() => removePreviewer(market.code, p.userId), `${p.email} no longer previews ${market.name}.`)}>
            Remove
          </Button>
        </div>
      ))}
      {!all && !q && matching.length > PREVIEWERS_SHOWN ? (
        <Button variant="ghost" size="sm" className="my-2 self-start" onClick={() => setAll(true)}>
          Show all {market.previewerCount}
        </Button>
      ) : null}
    </Panel>
  )
}
