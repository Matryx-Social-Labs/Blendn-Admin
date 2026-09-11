"use client"

import { useMemo, useState } from "react"
import { IconChevronDown, IconChevronRight, IconSearch } from "@tabler/icons-react"

import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { VENUE_TYPE_GROUPS, defaultExtentMetres } from "@/lib/venue-types"
import type { venue_type } from "@prisma/client"

/**
 * Pick one of thirty-five venue types.
 *
 * Grouped and collapsible rather than a flat select, because thirty-five
 * options in a dropdown is a scroll, not a choice. The groups match how someone
 * actually narrows: they know they run a food place before they know whether
 * the right word is "pub" or "brewery".
 *
 * Search flattens the groups, because someone who knows the word should not
 * have to guess which category we filed it under.
 */
export function VenueTypePicker({
  value,
  onChange,
}: {
  value: venue_type | null
  onChange: (type: venue_type) => void
}) {
  const [query, setQuery] = useState("")
  const [open, setOpen] = useState<Set<string>>(() => new Set(["Food & drink"]))

  const needle = query.trim().toLowerCase()
  const groups = useMemo(
    () =>
      VENUE_TYPE_GROUPS.map((g) => ({
        ...g,
        hits: needle
          ? g.types.filter(
              (t) =>
                t.label.toLowerCase().includes(needle) || g.label.toLowerCase().includes(needle)
            )
          : g.types,
      })).filter((g) => g.hits.length > 0),
    [needle]
  )

  return (
    <div className="flex flex-col gap-2.5">
      <div className="relative">
        <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search 35 venue types — brewery, banquet, campus…"
          aria-label="Search venue types"
          className="h-9 pl-8 text-[0.8125rem]"
        />
      </div>

      <div className="border-t border-border">
        {groups.map((group) => {
          const holdsValue = group.types.some((t) => t.value === value)
          const isOpen = !!needle || open.has(group.label) || holdsValue
          return (
            <div key={group.label} className="border-b border-border">
              <button
                type="button"
                onClick={() =>
                  setOpen((prev) => {
                    const next = new Set(prev)
                    if (next.has(group.label)) next.delete(group.label)
                    else next.add(group.label)
                    return next
                  })
                }
                aria-expanded={isOpen}
                className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left"
              >
                {isOpen ? (
                  <IconChevronDown className="size-3.5 text-faint-foreground" />
                ) : (
                  <IconChevronRight className="size-3.5 text-faint-foreground" />
                )}
                <b className="flex-1 text-[0.8125rem] font-bold">{group.label}</b>
                {holdsValue ? (
                  <Badge>{group.types.find((t) => t.value === value)?.label}</Badge>
                ) : null}
                <span className="text-[0.71875rem] text-faint-foreground">
                  {group.types.length}
                </span>
              </button>

              {isOpen ? (
                <div className="flex flex-wrap gap-1.5 px-3.5 pb-3 pl-9">
                  {group.hits.map((type) => (
                    <button
                      key={type.value}
                      type="button"
                      onClick={() => onChange(type.value)}
                      aria-pressed={value === type.value}
                      className={cn(
                        "rounded-full border px-3 py-1.5 text-[0.78125rem] transition-colors",
                        value === type.value
                          ? "border-primary bg-surface-raised"
                          : "border-border-strong hover:border-muted-foreground/50"
                      )}
                    >
                      {type.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          )
        })}

        {groups.length === 0 ? (
          <p className="px-4 py-3.5 text-[0.78125rem] text-muted-foreground">
            Nothing matches &ldquo;{query.trim()}&rdquo; — &ldquo;Something else&rdquo; under Other
            is the honest fallback.
          </p>
        ) : null}
      </div>

      {value ? (
        <p className="text-[0.75rem] text-faint-foreground">
          The type seeds a starting check-in extent (~{defaultExtentMetres(value)} m), so most
          venues never touch the handle.
        </p>
      ) : null}
    </div>
  )
}
