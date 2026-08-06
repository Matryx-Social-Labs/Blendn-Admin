"use client"

import { useEffect, useRef, useState } from "react"
import {
  IconBuildingStore,
  IconCheck,
  IconLoader2,
  IconPencil,
  IconSearch,
  IconX,
} from "@tabler/icons-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { searchVenues, type VenueOption } from "@/lib/venue-actions"

/**
 * Pick a listed venue, or keep typing a name.
 *
 * The event form re-asks six of the ten venue-shaped fields — name, address,
 * city, latitude, longitude, capacity — for a building that does not move.
 * Picking a listed venue fills all of them.
 *
 * Free text stays first-class and is not a fallback path: most events are at
 * places not on the platform, so a control implying you must choose from a list
 * would be wrong for the common case. This is a text input that happens to
 * suggest.
 */
export function VenuePicker({
  value,
  selected,
  onTextChange,
  onSelect,
  onClear,
}: {
  value: string
  selected: VenueOption | null
  onTextChange: (name: string) => void
  onSelect: (venue: VenueOption) => void
  onClear: () => void
}) {
  const [results, setResults] = useState<VenueOption[]>([])
  const [searching, setSearching] = useState(false)
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  // Suppressed rather than cleared: an effect that wrote [] back on every
  // short query is a render cascade for something derivable.
  const suggestions = selected || value.trim().length < 2 ? [] : results

  useEffect(() => {
    if (selected || value.trim().length < 2) return
    const q = value
    let cancelled = false
    const t = setTimeout(() => {
      if (cancelled) return
      setSearching(true)
      searchVenues(q)
        .then((hits) => {
          if (!cancelled) {
            setResults(hits)
            setOpen(hits.length > 0)
          }
        })
        // A failed lookup must not stop someone typing a venue name.
        .catch(() => {
          if (!cancelled) setResults([])
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [value, selected])

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDocClick)
    return () => document.removeEventListener("mousedown", onDocClick)
  }, [])

  if (selected) {
    return (
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-primary/40 bg-surface-raised px-4 py-3.5">
        <div className="flex items-start gap-3">
          <IconBuildingStore className="mt-0.5 size-5 text-primary" />
          <div className="flex flex-col gap-0.5">
            <span className="flex flex-wrap items-center gap-2">
              <b className="text-[0.875rem] font-bold">{selected.name}</b>
              <Badge variant="secondary">{selected.venueTypeLabel}</Badge>
              {selected.claimed ? <Badge>Claimed venue</Badge> : null}
            </span>
            <span className="text-[0.78125rem] text-muted-foreground">
              {[selected.address, selected.city].filter(Boolean).join(", ") || "No address on record"}
            </span>
            <span className="text-[0.75rem] text-faint-foreground">
              Location, capacity and check-in area come from the venue. Each stays editable
              below.
              {selected.claimed
                ? " The venue owner will see this event's attendee count and chatroom."
                : ""}
            </span>
          </div>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClear}>
          <IconX className="size-4" />
          Unlink
        </Button>
      </div>
    )
  }

  return (
    <div ref={boxRef} className="relative">
      <div className="relative">
        <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-faint-foreground" />
        <Input
          value={value}
          onChange={(e) => onTextChange(e.target.value)}
          onFocus={() => setOpen(suggestions.length > 0)}
          placeholder="Venue name — pick a listed one, or just type it"
          className="pl-8"
          autoComplete="off"
        />
        {searching ? (
          <IconLoader2 className="absolute right-2.5 top-1/2 size-4 -translate-y-1/2 animate-spin text-faint-foreground" />
        ) : null}
      </div>

      {open && suggestions.length > 0 ? (
        <ul className="absolute z-30 mt-1 flex w-full flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-lg">
          {suggestions.map((venue) => (
            <li key={venue.id}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onSelect(venue)
                  setOpen(false)
                }}
                className="flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left hover:bg-surface-raised"
              >
                <span className="flex flex-col">
                  <span className="flex items-center gap-2 text-[0.8125rem] font-medium">
                    {venue.name}
                    <span className="text-[0.71875rem] font-normal text-faint-foreground">
                      {venue.venueTypeLabel}
                    </span>
                  </span>
                  <span className="text-[0.75rem] text-faint-foreground">
                    {[venue.address, venue.city].filter(Boolean).join(", ") || "No address"}
                  </span>
                </span>
                <IconCheck className="size-4 shrink-0 text-faint-foreground" />
              </button>
            </li>
          ))}
          <li className="flex items-center gap-2 border-t border-border px-3.5 py-2 text-[0.75rem] text-faint-foreground">
            <IconPencil className="size-3.5" />
            Or keep typing — a venue does not have to be listed.
          </li>
        </ul>
      ) : null}
    </div>
  )
}
