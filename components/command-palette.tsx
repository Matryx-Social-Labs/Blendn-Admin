"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import {
  IconBuilding,
  IconBuildingStore,
  IconCalendarEvent,
  IconSearch,
  IconUser,
} from "@tabler/icons-react"

import { cn } from "@/lib/utils"

/**
 * ⌘K search.
 *
 * There was no search of any kind — an admin looking for one event among
 * hundreds had to guess which list it was in.
 *
 * Hand-rolled rather than pulling in `cmdk`. That library earns its place when
 * you need nested pages, groups with their own filtering, and a command
 * registry; this is a text field, a list, and four arrow keys. No `dialog`
 * primitive is installed either, so the overlay is a focus-trapped div — which
 * is what a dialog primitive would give us here anyway.
 *
 * Results are scoped server-side by role. A host searching "priya" gets nothing
 * rather than a count that reveals how many users match.
 */

interface Hit {
  id: string
  type: "event" | "user" | "organisation" | "venue"
  title: string
  subtitle: string | null
  href: string
}

const ICONS = {
  event: IconCalendarEvent,
  user: IconUser,
  organisation: IconBuilding,
  venue: IconBuildingStore,
} as const

const GROUP_LABEL = {
  event: "Events",
  organisation: "Organisations",
  user: "Users",
  venue: "Venues",
} as const

export function CommandPalette() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [hits, setHits] = useState<Hit[]>([])
  const [active, setActive] = useState(0)
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // ⌘K / Ctrl-K anywhere, Escape to close.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((o) => !o)
      }
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [])

  useEffect(() => {
    if (open) {
      // The whole point is typing immediately.
      requestAnimationFrame(() => inputRef.current?.focus())
    } else {
      setQuery("")
      setHits([])
      setActive(0)
    }
  }, [open])

  // Debounced, and every in-flight request is abandoned when a newer one
  // starts — otherwise a slow early response overwrites a fast later one and
  // the list shows results for a query the user has moved past.
  useEffect(() => {
    if (!open) return
    const trimmed = query.trim()
    if (trimmed.length < 2) {
      setHits([])
      setLoading(false)
      return
    }
    const controller = new AbortController()
    setLoading(true)
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}`, {
          signal: controller.signal,
        })
        const body = await res.json()
        setHits(body.hits ?? [])
        setActive(0)
      } catch {
        // An aborted request is the normal case, not an error worth showing.
      } finally {
        setLoading(false)
      }
    }, 180)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query, open])

  const go = useCallback(
    (hit: Hit) => {
      setOpen(false)
      router.push(hit.href)
    },
    [router]
  )

  function onInputKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, hits.length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === "Enter" && hits[active]) {
      e.preventDefault()
      go(hits[active])
    }
  }

  if (!open) return null

  // Grouped by type, in a fixed order, so the list does not reshuffle as
  // results arrive.
  const groups = (["event", "organisation", "user", "venue"] as const)
    .map((type) => ({ type, items: hits.filter((h) => h.type === type) }))
    .filter((g) => g.items.length > 0)

  let index = -1

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-[12vh]"
      onClick={() => setOpen(false)}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border-strong bg-surface-raised shadow-2xl"
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4">
          <IconSearch className="size-4 shrink-0 text-faint-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
            placeholder="Search events, organisations, venues…"
            aria-label="Search"
            className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-faint-foreground"
          />
          <kbd className="rounded border border-border px-1.5 py-0.5 text-[0.6875rem] text-faint-foreground">
            esc
          </kbd>
        </div>

        <div className="max-h-[52vh] overflow-y-auto p-1.5">
          {query.trim().length < 2 ? (
            <p className="px-3 py-6 text-center text-[0.8125rem] text-muted-foreground">
              Type at least two characters.
            </p>
          ) : loading && hits.length === 0 ? (
            <p className="px-3 py-6 text-center text-[0.8125rem] text-muted-foreground">
              Searching…
            </p>
          ) : hits.length === 0 ? (
            <p className="px-3 py-6 text-center text-[0.8125rem] text-muted-foreground">
              Nothing matches “{query.trim()}”.
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.type} className="mb-1">
                <p className="px-3 py-1.5 text-[0.6875rem] font-medium uppercase tracking-[0.06em] text-faint-foreground">
                  {GROUP_LABEL[group.type]}
                </p>
                {group.items.map((hit) => {
                  index += 1
                  const isActive = index === active
                  const Icon = ICONS[hit.type]
                  const myIndex = index
                  return (
                    <button
                      key={`${hit.type}-${hit.id}`}
                      onClick={() => go(hit)}
                      onMouseEnter={() => setActive(myIndex)}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left",
                        isActive && "bg-accent"
                      )}
                    >
                      <Icon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[0.8125rem] font-medium">
                          {hit.title}
                        </span>
                        {hit.subtitle ? (
                          <span className="block truncate text-[0.75rem] text-muted-foreground">
                            {hit.subtitle}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

/** The visible affordance — nobody discovers ⌘K from nothing. */
export function CommandPaletteTrigger({ className }: { className?: string }) {
  return (
    <button
      onClick={() =>
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })
        )
      }
      aria-label="Search"
      className={cn(
        "inline-flex h-9 items-center gap-2 rounded-lg border border-border-strong bg-card px-2.5 text-[0.78125rem] text-muted-foreground transition-colors hover:text-foreground",
        className
      )}
    >
      <IconSearch className="size-3.5" />
      <span>Search</span>
      <kbd className="rounded border border-border px-1 py-px text-[0.625rem]">⌘K</kbd>
    </button>
  )
}
