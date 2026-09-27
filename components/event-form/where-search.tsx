"use client"

import { useId, useRef, useState } from "react"
import { IconBuildingStore, IconMapPin, IconPlus, IconSearch, IconX } from "@tabler/icons-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { LocationData } from "@/components/location-picker"
import { extractAddress } from "@/lib/address"
import { outlineFromGeoJson } from "@/lib/outline"
import { cn } from "@/lib/utils"
import { searchVenues, type VenueOption } from "@/lib/venue-actions"

interface GeocodeHit {
  place_id: number
  lat: string
  lon: string
  display_name: string
  name?: string
  address?: Record<string, string>
  /** Polygon for a place OSM holds as an area; a Point for a pin. */
  geojson?: unknown
}

/** A place picked from the geocoder, not yet a listed venue. */
export interface PickedPlace {
  /** What the organiser will call it: OSM's name, else the first part of the address. */
  name: string
  location: LocationData
}

type Option = { kind: "venue"; venue: VenueOption } | { kind: "place"; hit: GeocodeHit }

const hasOutline = (geofence: unknown) =>
  !!geofence && typeof geofence === "object" && (geofence as { type?: unknown }).type === "polygon"

/**
 * "Where" starts with the venue: one input for listed venues and new places
 * (SCRUM-353, owner's call 2026-09-27).
 *
 * It replaced two: a venue-name box above the map and an address search on
 * it, answering one question twice. Listed venues come first — picking one
 * brings its outline and buffer, so nothing is redrawn — then places from the
 * geocoder, to add. Free text still sets the venue name, for somewhere with no
 * address at all.
 *
 * A combobox: arrows move through both groups, Enter picks, Escape closes.
 * Only the newest query's answers are shown (SCRUM-341).
 */
export function WhereSearch({
  value,
  selected,
  onTextChange,
  onPickVenue,
  onPickPlace,
  onClear,
}: {
  value: string
  selected: VenueOption | null
  onTextChange: (name: string) => void
  onPickVenue: (venue: VenueOption) => void
  onPickPlace: (place: PickedPlace) => void
  onClear: () => void
}) {
  const listId = useId()
  const [venues, setVenues] = useState<VenueOption[]>([])
  const [places, setPlaces] = useState<GeocodeHit[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [searching, setSearching] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const seq = useRef(0)

  const options: Option[] = [
    ...venues.map((venue) => ({ kind: "venue" as const, venue })),
    ...places.map((hit) => ({ kind: "place" as const, hit })),
  ]

  function search(q: string) {
    onTextChange(q)
    clearTimeout(timer.current)
    const mine = ++seq.current
    if (q.trim().length < 2) {
      setVenues([])
      setPlaces([])
      setOpen(false)
      setSearching(false)
      return
    }
    timer.current = setTimeout(async () => {
      setSearching(true)
      // Either half failing leaves the other: a geocoder outage must not hide
      // the listed venues, nor the reverse.
      const [listed, found] = await Promise.allSettled([
        searchVenues(q),
        fetch(`/api/geocode?q=${encodeURIComponent(q)}`, { headers: { "Accept-Language": "en" } }).then((r) =>
          r.ok ? (r.json() as Promise<GeocodeHit[]>) : []
        ),
      ])
      if (mine !== seq.current) return
      setVenues(listed.status === "fulfilled" ? listed.value : [])
      setPlaces(found.status === "fulfilled" && Array.isArray(found.value) ? found.value : [])
      setActive(0)
      setOpen(true)
      setSearching(false)
    }, 350)
  }

  /** Leaving the input: a search in flight must not reopen the list later. */
  function cancel() {
    clearTimeout(timer.current)
    ++seq.current
    setSearching(false)
    setOpen(false)
  }

  function pick(option: Option) {
    clearTimeout(timer.current)
    ++seq.current
    setSearching(false)
    setOpen(false)
    setVenues([])
    setPlaces([])
    if (option.kind === "venue") return onPickVenue(option.venue)

    const { hit } = option
    const lat = Number(hit.lat)
    const lng = Number(hit.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return
    const resolved = extractAddress(lat, lng, hit)
    onPickPlace({
      name: hit.name?.trim() || hit.display_name.split(",")[0].trim(),
      location: {
        lat,
        lng,
        address: resolved.address,
        city: resolved.city,
        state: resolved.state,
        country: resolved.country,
        postal_code: resolved.postalCode,
        outline: outlineFromGeoJson(hit.geojson),
      },
    })
  }

  if (selected) {
    return (
      <div className="flex min-h-10 flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg border border-border-strong px-3 py-2">
        <IconBuildingStore className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <b className="text-[0.84375rem] font-semibold">{selected.name}</b>
        <span className="text-[0.75rem] text-muted-foreground">
          {[selected.venueTypeLabel, selected.city].filter(Boolean).join(" · ")}
        </span>
        {hasOutline(selected.geofence) ? <Badge variant="outline">outline</Badge> : null}
        {selected.claimed ? <Badge variant="outline">claimed</Badge> : null}
        <span className="flex-1" />
        <Button type="button" variant="ghost" size="sm" onClick={onClear} aria-label="Unlink the venue">
          <IconX className="size-4" />
        </Button>
      </div>
    )
  }

  const showList = open && options.length > 0
  const venueCount = venues.length

  return (
    <div className="relative">
      <div className="flex h-10 items-center gap-2 rounded-lg border border-input px-3 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30">
        <IconSearch className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <input
          role="combobox"
          aria-label="Venue or address"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList ? `${listId}-${active}` : undefined}
          value={value}
          placeholder="Venue or address — pick a listed venue, or add a place"
          className="min-w-0 flex-1 bg-transparent text-[0.84375rem] outline-none placeholder:text-muted-foreground"
          autoComplete="off"
          onChange={(e) => search(e.target.value)}
          onFocus={() => options.length > 0 && setOpen(true)}
          onBlur={cancel}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && options.length) {
              e.preventDefault()
              setOpen(true)
              setActive((i) => (i + 1) % options.length)
            } else if (e.key === "ArrowUp" && options.length) {
              e.preventDefault()
              setActive((i) => (i - 1 + options.length) % options.length)
            } else if (e.key === "Enter") {
              // Never submit the event form from here.
              e.preventDefault()
              if (showList) pick(options[active])
            } else if (e.key === "Escape") {
              setOpen(false)
            }
          }}
        />
        {searching ? <span className="text-[0.6875rem] text-muted-foreground">Searching…</span> : null}
      </div>

      {showList ? (
        <div
          id={listId}
          role="listbox"
          className="absolute z-[900] mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-border-strong bg-popover p-1 shadow-lg"
        >
          {/* Real groups, so a screen reader hears where the listed venues end. */}
          {[
            { key: "venues", label: "Listed venues", from: 0, to: venueCount },
            { key: "places", label: "Add a new place", from: venueCount, to: options.length },
          ]
            .filter((g) => g.to > g.from)
            .map((g) => (
              <div key={g.key} role="group" aria-labelledby={`${listId}-${g.key}`}>
                <Group id={`${listId}-${g.key}`}>{g.label}</Group>
                {options.slice(g.from, g.to).map((option, k) => {
                  const i = g.from + k
                  return (
                    <div
                      key={option.kind === "venue" ? `v-${option.venue.id}` : `p-${option.hit.place_id}`}
                      id={`${listId}-${i}`}
                      role="option"
                      aria-selected={i === active}
                      // Pick before the input's blur can close the list.
                      onMouseDown={(e) => {
                        e.preventDefault()
                        pick(option)
                      }}
                      onMouseEnter={() => setActive(i)}
                      className={cn(
                        "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[0.8125rem]",
                        i === active && "bg-accent"
                      )}
                    >
                      {option.kind === "venue" ? (
                        <>
                          <IconMapPin className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                          <span className="min-w-0 flex-1 truncate">{option.venue.name}</span>
                          {hasOutline(option.venue.geofence) ? <Badge variant="outline">outline</Badge> : null}
                          <span className="shrink-0 text-[0.75rem] text-muted-foreground">
                            {[option.venue.venueTypeLabel, option.venue.city].filter(Boolean).join(" · ")}
                          </span>
                        </>
                      ) : (
                        <>
                          <IconPlus className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                          <span className="min-w-0 flex-1 truncate">{option.hit.display_name}</span>
                          <span className="shrink-0 text-[0.75rem] text-muted-foreground">
                            {outlineFromGeoJson(option.hit.geojson) ? "OSM · area" : "OSM · pin"}
                          </span>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            ))}
        </div>
      ) : null}
    </div>
  )
}

function Group({ id, children }: { id: string; children: string }) {
  return (
    <p id={id} className="px-2 pb-1 pt-2 text-[0.6875rem] font-medium uppercase tracking-[0.06em] text-muted-foreground">
      {children}
    </p>
  )
}
