"use client"

import { useState, useTransition, type FormEvent, type ReactNode } from "react"
import { toast } from "sonner"

import { Panel } from "@/components/dashboard/kit"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { createCity, createMarket, type MarketView } from "@/lib/market-actions"
import { TAKES_OFFLINE } from "@/lib/market-input"
import { refusalMessage } from "@/lib/refusal"

/*
 * A city and a country are rows: these two forms are how a new one is added
 * without code. Both start hidden. The server checks every field again
 * (`lib/market-input.ts`) and says why in words; the form only collects.
 */

function Field({ id, label, help, children }: { id: string; label: string; help?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {help ? <p className="text-[0.75rem] text-faint-foreground">{help}</p> : null}
    </div>
  )
}

const CITY_FIELDS = ["name", "slug", "region", "matchNames", "timezone", "licensedMinAge", "centreLat", "centreLon", "minLat", "minLon", "maxLat", "maxLon"] as const
type CityField = (typeof CITY_FIELDS)[number]
const blankCity = () => Object.fromEntries(CITY_FIELDS.map((f) => [f, ""])) as Record<CityField, string>

export function AddForms({ markets }: { markets: MarketView[] }) {
  const [busy, startTransition] = useTransition()
  const [marketCode, setMarketCode] = useState(markets[0]?.code ?? "")
  const [city, setCity] = useState(blankCity)
  const [market, setMarket] = useState({ code: "", name: "", currency: "", locale: "" })
  // Shown only once the server says listed rows already name the city (`createCity`).
  const [offlineAsked, setOfflineAsked] = useState(false)
  const [takeOffline, setTakeOffline] = useState(false)

  const submit = (e: FormEvent, fn: () => Promise<void>, ok: string, reset: () => void, onRefusal?: (message: string) => void) => {
    e.preventDefault()
    startTransition(async () => {
      try {
        await fn()
        toast.success(ok)
        reset()
      } catch (err) {
        const message = refusalMessage(err, "That did not work")
        onRefusal?.(message)
        toast.error(message)
      }
    })
  }
  const resetCity = () => {
    setCity(blankCity())
    setOfflineAsked(false)
    setTakeOffline(false)
  }

  const cityInput = (field: CityField, label: string, extra: { help?: string; inputMode?: "decimal" | "numeric"; placeholder?: string } = {}) => (
    <Field id={`city-${field}`} label={label} help={extra.help}>
      <Input
        id={`city-${field}`}
        value={city[field]}
        inputMode={extra.inputMode}
        placeholder={extra.placeholder}
        onChange={(e) => setCity((c) => ({ ...c, [field]: e.target.value }))}
      />
    </Field>
  )
  const marketInput = (field: keyof typeof market, label: string, placeholder: string) => (
    <Field id={`market-${field}`} label={label}>
      <Input id={`market-${field}`} value={market[field]} placeholder={placeholder} onChange={(e) => setMarket((m) => ({ ...m, [field]: e.target.value }))} />
    </Field>
  )

  return (
    <div className="grid gap-5 @5xl/main:grid-cols-2">
      <Panel title="Add a city" hint="starts hidden">
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) =>
            submit(e, () => createCity({ marketCode, ...city, takeOffline }), `${city.name.trim()} added, hidden.`, resetCity, (message) => {
              if (message.includes(TAKES_OFFLINE)) setOfflineAsked(true)
            })
          }
        >
          <div className="grid grid-cols-2 gap-3">
            <Field id="city-market" label="Country">
              <Select value={marketCode} onValueChange={setMarketCode}>
                <SelectTrigger id="city-market">
                  <SelectValue placeholder="Choose a country" />
                </SelectTrigger>
                <SelectContent>
                  {markets.map((m) => (
                    <SelectItem key={m.code} value={m.code}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            {cityInput("name", "Name", { placeholder: "e.g. Toronto" })}
            {cityInput("slug", "Slug", { placeholder: "e.g. toronto" })}
            {cityInput("region", "Region", { placeholder: "e.g. ON" })}
            {cityInput("timezone", "Timezone", { placeholder: "e.g. America/Toronto" })}
            {cityInput("licensedMinAge", "Licensed min age", { inputMode: "numeric", help: "Optional" })}
          </div>
          {cityInput("matchNames", "Match names", { placeholder: "e.g. toronto, north york", help: "Every spelling of the city that events and venues use, comma-separated" })}
          <div className="grid grid-cols-2 gap-3">
            {cityInput("centreLat", "Center latitude", { inputMode: "decimal" })}
            {cityInput("centreLon", "Center longitude", { inputMode: "decimal" })}
          </div>
          <div className="grid grid-cols-2 gap-3 @3xl/main:grid-cols-4">
            {cityInput("minLat", "Min latitude", { inputMode: "decimal" })}
            {cityInput("minLon", "Min longitude", { inputMode: "decimal" })}
            {cityInput("maxLat", "Max latitude", { inputMode: "decimal" })}
            {cityInput("maxLon", "Max longitude", { inputMode: "decimal" })}
          </div>
          {offlineAsked ? (
            <div className="flex items-center gap-2">
              <Checkbox id="city-take-offline" checked={takeOffline} onCheckedChange={(v) => setTakeOffline(v === true)} />
              <Label htmlFor="city-take-offline">Take them offline until it is live</Label>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={busy || !marketCode}>
              Add city
            </Button>
            <p className="text-[0.75rem] text-faint-foreground">Nobody sees it until you set it to Preview or Live.</p>
          </div>
        </form>
      </Panel>

      <Panel title="Add a country" hint="starts hidden">
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => submit(e, () => createMarket(market), `${market.name.trim()} added, hidden.`, () => setMarket({ code: "", name: "", currency: "", locale: "" }))}
        >
          <div className="grid grid-cols-2 gap-3">
            {marketInput("code", "Country code", "e.g. DE")}
            {marketInput("name", "Name", "e.g. Germany")}
            {marketInput("currency", "Currency", "e.g. EUR")}
            {marketInput("locale", "Locale", "e.g. de-DE")}
          </div>
          <p className="text-[0.75rem] text-faint-foreground">Code is ISO 3166 (two letters), currency ISO 4217 (three). The currency can&rsquo;t be changed here later.</p>
          <Button type="submit" variant="outline" disabled={busy} className="self-start">
            Add country
          </Button>
        </form>
      </Panel>
    </div>
  )
}
