"use client"

import { useId, useRef, useState } from "react"
import { IconMapPin, IconSearch } from "@tabler/icons-react"
import { extractAddress } from "@/lib/address"
import type { LocationData } from "@/components/location-picker"
import { cn } from "@/lib/utils"

interface GeocodeHit {
  place_id: number
  lat: string
  lon: string
  display_name: string
  address?: Record<string, string>
}

/**
 * The address search that sits on the event form's one map (top-left).
 *
 * It replaced a second map: `LocationPicker` had its own pin and its own
 * circle beside the check-in area editor, and the two disagreed once an area
 * existed. Here a pick only reports a location; the section moves the one pin
 * and the area with it.
 *
 * A combobox: arrows move, Enter picks, Escape closes. Only the newest query's
 * answer is shown — two quick queries can resolve out of order (SCRUM-341).
 */
export function AddressSearch({ onPick }: { onPick: (location: LocationData) => void }) {
  const listId = useId()
  const [query, setQuery] = useState("")
  const [hits, setHits] = useState<GeocodeHit[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [searching, setSearching] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const seq = useRef(0)

  function search(q: string) {
    setQuery(q)
    clearTimeout(timer.current)
    const mine = ++seq.current
    if (!q.trim()) {
      setHits([])
      setOpen(false)
      setSearching(false)
      return
    }
    timer.current = setTimeout(async () => {
      setSearching(true)
      try {
        const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`, { headers: { "Accept-Language": "en" } })
        const data = (await res.json()) as GeocodeHit[]
        if (mine !== seq.current) return
        setHits(Array.isArray(data) ? data : [])
        setActive(0)
        setOpen(true)
      } catch {
        if (mine === seq.current) setHits([])
      } finally {
        if (mine === seq.current) setSearching(false)
      }
    }, 450)
  }

  function pick(hit: GeocodeHit) {
    const lat = Number(hit.lat)
    const lng = Number(hit.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return
    const resolved = extractAddress(lat, lng, hit)
    ++seq.current
    setQuery(hit.display_name)
    setHits([])
    setOpen(false)
    onPick({
      lat,
      lng,
      address: resolved.address,
      city: resolved.city,
      state: resolved.state,
      country: resolved.country,
      postal_code: resolved.postalCode,
    })
  }

  const showList = open && hits.length > 0

  return (
    <div className="relative">
      <div className="flex h-9 items-center gap-2 rounded-lg border border-border-strong bg-background px-3 shadow-sm focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30">
        <IconSearch className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <input
          role="combobox"
          aria-label="Find the address"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList ? `${listId}-${active}` : undefined}
          value={query}
          placeholder="Find the address"
          className="min-w-0 flex-1 bg-transparent text-[0.84375rem] outline-none placeholder:text-muted-foreground"
          onChange={(e) => search(e.target.value)}
          onFocus={() => hits.length > 0 && setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && hits.length) {
              e.preventDefault()
              setOpen(true)
              setActive((i) => (i + 1) % hits.length)
            } else if (e.key === "ArrowUp" && hits.length) {
              e.preventDefault()
              setActive((i) => (i - 1 + hits.length) % hits.length)
            } else if (e.key === "Enter") {
              // Never submit the event form from here.
              e.preventDefault()
              if (showList) pick(hits[active])
            } else if (e.key === "Escape") {
              setOpen(false)
            }
          }}
        />
        {searching ? <span className="text-[0.6875rem] text-muted-foreground">Searching…</span> : null}
      </div>
      {showList ? (
        <ul
          id={listId}
          role="listbox"
          className="mt-1 max-h-60 overflow-y-auto rounded-lg border border-border-strong bg-background p-1 shadow-sm"
        >
          {hits.map((hit, i) => (
            <li
              key={hit.place_id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                // Pick before the input's blur can close the list.
                e.preventDefault()
                pick(hit)
              }}
              onMouseEnter={() => setActive(i)}
              className={cn(
                "flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-[0.8125rem]",
                i === active && "bg-accent"
              )}
            >
              <IconMapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="line-clamp-2">{hit.display_name}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
