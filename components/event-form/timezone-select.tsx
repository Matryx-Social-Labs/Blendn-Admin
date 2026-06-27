"use client"

import { useMemo, useState } from "react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

export const ALL_TIMEZONES: string[] = (() => {
  try {
    return (Intl as typeof Intl & { supportedValuesOf: (k: string) => string[] }).supportedValuesOf("timeZone")
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

export function TimezoneSelect({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  const [query, setQuery] = useState(value)
  const [open, setOpen] = useState(false)

  const filtered = useMemo(() => {
    const q = query.toLowerCase()
    if (!q) return ALL_TIMEZONES.slice(0, 50)
    return ALL_TIMEZONES.filter((tz) => tz.toLowerCase().includes(q)).slice(0, 50)
  }, [query])

  const select = (tz: string) => {
    onChange(tz)
    setQuery(tz)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          placeholder="Search timezone…"
        />
      </PopoverTrigger>
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
