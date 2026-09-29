"use client"

import { useMemo, useState } from "react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
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

export function TimezoneSelect({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  const [query, setQuery] = useState(value)
  const [open, setOpen] = useState(false)

  const filtered = useMemo(() => timezoneOptions(query, value), [query, value])

  const select = (tz: string) => {
    onChange(tz)
    setQuery(tz)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/*
       * An anchor, not a trigger. PopoverTrigger gives its child type="button",
       * and an <input type="button"> takes no typing, so the timezone could
       * not be changed at all (SCRUM-453). Opening is the input's own job.
       */}
      <PopoverAnchor asChild>
        <Input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          placeholder="Search timezone…"
        />
      </PopoverAnchor>
      {filtered.length > 0 && (
        <PopoverContent
          align="start"
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="w-[var(--radix-popover-trigger-width)] p-0 max-h-48 overflow-y-auto"
        >
          {filtered.map((tz) => (
            <Button
              key={tz}
              type="button"
              variant="ghost"
              className={`w-full justify-start rounded-none px-3 py-1.5 h-auto text-left text-sm font-normal hover:bg-muted ${tz === value ? "font-medium" : ""}`}
              onClick={() => select(tz)}
            >
              {tz}
            </Button>
          ))}
        </PopoverContent>
      )}
    </Popover>
  )
}
