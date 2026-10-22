"use client"

import { useId, useMemo, useState } from "react"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover"

/*
 * The names these zones have now. Browsers list CLDR ids, and some are the old
 * names -- Chrome 145 and Node 25 give Asia/Calcutta, not Asia/Kolkata -- so
 * typing "Kolkata" found nothing and the new-event default, Asia/Kolkata, was
 * not in the list (SCRUM-453). Both names are valid IANA ids.
 */
const CURRENT_NAME: Record<string, string> = {
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Asia/Rangoon": "Asia/Yangon",
  "Europe/Kiev": "Europe/Kyiv",
  "America/Godthab": "America/Nuuk",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Pacific/Truk": "Pacific/Chuuk",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Enderbury": "Pacific/Kanton",
}

export const ALL_TIMEZONES: string[] = (() => {
  try {
    return (Intl as typeof Intl & { supportedValuesOf: (k: string) => string[] })
      .supportedValuesOf("timeZone")
      .map((tz) => CURRENT_NAME[tz] ?? tz)
  } catch {
    return [
      "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
      "America/Anchorage", "Pacific/Honolulu", "Europe/London", "Europe/Paris",
      "Europe/Berlin", "Europe/Moscow", "Asia/Dubai", "Asia/Kolkata", "Asia/Bangkok",
      "Asia/Shanghai", "Asia/Tokyo", "Australia/Sydney", "Pacific/Auckland",
      "UTC",
    ]
  }
})()

/**
 * What the list offers for what is typed. Opened on the current value it offers
 * the other zones too; filtering by the current value left exactly one
 * (SCRUM-453).
 */
export function timezoneOptions(query: string, value: string): string[] {
  const q = query.trim().toLowerCase()
  if (!q || query === value) return ALL_TIMEZONES.slice(0, 50)
  return ALL_TIMEZONES.filter((tz) => tz.toLowerCase().includes(q)).slice(0, 50)
}

/** The current name for a zone id a browser reports: Asia/Calcutta → Asia/Kolkata. */
export function currentZoneName(tz: string): string {
  return CURRENT_NAME[tz] ?? tz
}

/**
 * What Enter picks: the first zone for what is typed, or the current value
 * when nothing new was typed or nothing matches.
 */
export function zoneForEnter(query: string, value: string): string {
  if (!query.trim() || query === value) return value
  return timezoneOptions(query, value)[0] ?? value
}

/**
 * Where the active option goes for a key, in a list of `count`. Arrow keys
 * wrap; Home and End jump; anything else leaves it. -1 is "none yet".
 */
export function moveActive(current: number, key: string, count: number): number {
  if (count === 0) return -1
  if (key === "ArrowDown") return current < 0 || current >= count - 1 ? 0 : current + 1
  if (key === "ArrowUp") return current <= 0 ? count - 1 : current - 1
  if (key === "Home") return 0
  if (key === "End") return count - 1
  return current
}

/**
 * A searchable timezone picker, as the ARIA combobox pattern: a text box that
 * owns a listbox (`aria-controls`), names the option the arrow keys are on
 * (`aria-activedescendant`) while focus stays in the box, and picks it with
 * Enter. Escape and a click outside close it without changing the value.
 *
 * `FormControl` hands its `id`, `aria-describedby` and `aria-invalid` to its
 * child; they land on the text box, so the label points at it and an error is
 * announced with it.
 */
export function TimezoneSelect({
  value,
  onChange,
  ...control
}: {
  value: string
  onChange: (v: string) => void
  id?: string
  "aria-describedby"?: string
  "aria-invalid"?: boolean
}) {
  const [query, setQuery] = useState(value)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const listId = useId()

  const filtered = useMemo(() => timezoneOptions(query, value), [query, value])
  // Clamped while rendering, so a shorter list never points past its end.
  const activeIndex = active < filtered.length ? active : -1
  const optionId = (i: number) => `${listId}-option-${i}`

  const select = (tz: string) => {
    onChange(tz)
    setQuery(tz)
    setOpen(false)
    setActive(-1)
  }

  // Closing without a pick puts the box back to the value the form holds, so
  // it never shows a zone that will not be saved.
  const onOpenChange = (next: boolean) => {
    setOpen(next)
    if (!next) {
      setQuery(value)
      setActive(-1)
    }
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {/*
       * An anchor, not a trigger. PopoverTrigger gives its child type="button",
       * and an <input type="button"> takes no typing, so the timezone could
       * not be changed at all (SCRUM-453). Opening is the input's own job.
       */}
      <PopoverAnchor asChild>
        <Input
          {...control}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(-1)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onKeyDown={(e) => {
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
              e.preventDefault()
              setOpen(true)
              const next = moveActive(activeIndex, e.key, filtered.length)
              setActive(next)
              document.getElementById(optionId(next))?.scrollIntoView({ block: "nearest" })
              return
            }
            if (e.key !== "Enter") return
            // Enter in a text box submits the form, with the old zone. Here it picks.
            e.preventDefault()
            select(open && activeIndex >= 0 ? filtered[activeIndex] : zoneForEnter(query, value))
          }}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
          data-timezone-search=""
          placeholder="Search timezone…"
        />
      </PopoverAnchor>
      {/*
       * Rendered even with no matches: with nothing mounted, Escape and a click
       * outside reached no dismiss handler, and the box kept showing text the
       * form would not save.
       */}
      <PopoverContent
        align="start"
        onOpenAutoFocus={(e) => e.preventDefault()}
        // The search box is outside the content; a click in it is not a dismissal.
        onInteractOutside={(e) => {
          if ((e.target as Element | null)?.closest?.("[data-timezone-search]")) e.preventDefault()
        }}
        className="w-[var(--radix-popover-trigger-width)] p-0 max-h-48 overflow-y-auto"
      >
        {filtered.length === 0 && (
          <p className="px-3 py-2 text-sm text-muted-foreground">No timezone matches “{query}”.</p>
        )}
        <ul role="listbox" id={listId} aria-label="Timezones">
          {filtered.map((tz, i) => (
            <li
              key={tz}
              id={optionId(i)}
              role="option"
              aria-selected={tz === value}
              // Keeps focus in the text box, where the combobox lives.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => select(tz)}
              className={cn(
                "cursor-pointer px-3 py-1.5 text-sm hover:bg-muted pointer-coarse:py-3",
                tz === value && "font-medium",
                i === activeIndex && "bg-muted"
              )}
            >
              {tz}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
