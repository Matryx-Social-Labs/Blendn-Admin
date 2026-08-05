"use client"

import { useState, useTransition } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { IconCalendarStats } from "@tabler/icons-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import {
  DEFAULT_RANGE,
  RANGE_PRESETS,
  rangeToParams,
  type RangeKey,
} from "@/lib/date-range"

/**
 * The global date range, in the top bar.
 *
 * This replaces a chip that displayed today's date and did nothing — not a
 * control, not a filter, and computed with `new Date()` during client render,
 * which is a hydration mismatch waiting to happen.
 *
 * Writing to the URL rather than to context is what lets the server components
 * below it read the range and query the right window. Every chart and table on
 * the page reads the same `searchParams`, so they cannot disagree about what
 * period is on screen.
 */
export function DateRangeControl({ className }: { className?: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)

  const active = (searchParams.get("range") as RangeKey | null) ?? DEFAULT_RANGE
  const [from, setFrom] = useState(searchParams.get("from") ?? "")
  const [to, setTo] = useState(searchParams.get("to") ?? "")

  function apply(key: RangeKey, custom?: { from: string; to: string }) {
    const params = rangeToParams(key, custom)
    // Anything else already in the URL — a table filter, a page number — has to
    // survive changing the window. Only the range keys are replaced.
    searchParams.forEach((value, name) => {
      if (name !== "range" && name !== "from" && name !== "to") params.set(name, value)
    })
    const query = params.toString()
    startTransition(() => router.push(query ? `${pathname}?${query}` : pathname))
  }

  return (
    <div
      role="group"
      aria-label="Date range for every chart and table on this page"
      className={cn(
        "inline-flex items-center gap-0.5 rounded-lg border border-border-strong bg-card p-[3px]",
        pending && "opacity-70",
        className
      )}
    >
      <IconCalendarStats
        aria-hidden
        className="mx-1 size-[15px] shrink-0 text-faint-foreground"
      />
      {RANGE_PRESETS.map((preset) =>
        preset.key === "custom" ? (
          <Popover key={preset.key} open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <button
                aria-pressed={active === "custom"}
                className={presetClass(active === "custom")}
              >
                {active === "custom" && from && to ? `${from} → ${to}` : "Custom"}
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="flex w-64 flex-col gap-2.5">
              <span className="text-[0.75rem] text-muted-foreground">Custom range</span>
              <div className="flex items-center gap-2">
                <Input
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  aria-label="From date"
                  className="h-8 text-[0.8125rem]"
                />
                <span className="text-[0.75rem] text-faint-foreground">→</span>
                <Input
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  aria-label="To date"
                  className="h-8 text-[0.8125rem]"
                />
              </div>
              <Button
                size="sm"
                disabled={!from || !to}
                onClick={() => {
                  apply("custom", { from, to })
                  setOpen(false)
                }}
              >
                Apply
              </Button>
            </PopoverContent>
          </Popover>
        ) : (
          <button
            key={preset.key}
            onClick={() => apply(preset.key)}
            aria-pressed={active === preset.key}
            className={presetClass(active === preset.key)}
          >
            {preset.label}
          </button>
        )
      )}
    </div>
  )
}

function presetClass(isActive: boolean) {
  return cn(
    "cursor-pointer whitespace-nowrap rounded-md border px-2.5 py-[5px] text-[0.78125rem] transition-colors",
    isActive
      ? "border-border-strong bg-surface-raised font-bold text-foreground"
      : "border-transparent text-muted-foreground hover:text-foreground"
  )
}
