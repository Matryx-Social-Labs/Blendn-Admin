"use client"

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import { useRouter } from "next/navigation"
import * as Dialog from "@radix-ui/react-dialog"
import {
  IconBuilding,
  IconBuildingStore,
  IconCalendarEvent,
  IconSearch,
  IconUser,
} from "@tabler/icons-react"

import { cn } from "@/lib/utils"

/**
 * ⌘K search: the top bar's field, and the dialog it opens.
 *
 * There was no search of any kind — an admin looking for one event among
 * hundreds had to guess which list it was in.
 *
 * ## A real dialog, outside the top bar
 *
 * The overlay used to render inside the top bar, whose `backdrop-filter`
 * makes it the containing block for anything `position: fixed` within it — so
 * the "full-screen" backdrop was 60px tall, the page stayed clickable behind
 * an `aria-modal` dialog, and nothing trapped or returned focus. Radix Dialog
 * portals to `<body>`, traps focus, closes on Escape and gives focus back to
 * the field that opened it.
 *
 * ## A combobox over a listbox
 *
 * The input owns the keyboard (arrows, Enter), so the highlighted result is
 * announced through `aria-activedescendant`, and the number of results through
 * a polite live region — typing and hearing nothing was the old behaviour.
 *
 * Results are scoped server-side by role. A host searching "priya" gets
 * nothing rather than a count that reveals how many users match.
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

const LISTBOX_ID = "command-palette-results"
const optionId = (i: number) => `command-palette-option-${i}`

/**
 * Apple keyboards say ⌘K; everyone else's say Ctrl K, and both work. The
 * server cannot know, so it renders ⌘K and a non-Mac client corrects it after
 * hydration — `useSyncExternalStore`'s server snapshot is what keeps that from
 * being a hydration mismatch.
 */
const noSubscription = () => () => {}
function useIsApple() {
  return useSyncExternalStore(
    noSubscription,
    () => /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent),
    () => true
  )
}

export function CommandPalette({ placeholder }: { placeholder: string }) {
  const router = useRouter()
  const isApple = useIsApple()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  // The results and the query they answer, together: until they match the
  // query on screen, the honest status is "Searching…", not "Nothing matches".
  const [results, setResults] = useState<{ for: string; hits: Hit[] }>({ for: "", hits: [] })
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const changeOpen = useCallback((next: boolean) => {
    setOpen(next)
    if (!next) {
      setQuery("")
      setResults({ for: "", hits: [] })
      setActive(0)
    }
  }, [])

  // ⌘K / Ctrl-K anywhere. Escape belongs to the dialog.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [])

  // Debounced, and every in-flight request is abandoned when a newer one
  // starts — otherwise a slow early response overwrites a fast later one and
  // the list shows results for a query the user has moved past.
  useEffect(() => {
    if (!open) return
    const trimmed = query.trim()
    if (trimmed.length < 2) return
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}`, {
          signal: controller.signal,
        })
        const body = await res.json()
        setResults({ for: trimmed, hits: body.hits ?? [] })
        setActive(0)
      } catch {
        // An aborted request is the normal case, not an error worth showing.
      }
    }, 180)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query, open])

  const go = useCallback(
    (hit: Hit) => {
      changeOpen(false)
      router.push(hit.href)
    },
    [router, changeOpen]
  )

  const trimmed = query.trim()
  const typed = trimmed.length >= 2
  const answered = typed && results.for === trimmed
  // Results for any other query are stale; never show them.
  const shown = answered ? results.hits : []

  function onInputKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setActive((i) => Math.min(i + 1, shown.length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (e.key === "Enter" && shown[active]) {
      e.preventDefault()
      go(shown[active])
    }
  }

  // Grouped by type, in a fixed order, so the list does not reshuffle as
  // results arrive.
  const groups = (["event", "organisation", "user", "venue"] as const)
    .map((type) => ({ type, items: shown.filter((h) => h.type === type) }))
    .filter((g) => g.items.length > 0)

  const status = !typed
    ? "Type at least two characters."
    : !answered
      ? "Searching…"
      : shown.length === 0
        ? `Nothing matches “${trimmed}”.`
        : `${shown.length} result${shown.length === 1 ? "" : "s"}.`

  let index = -1

  return (
    <Dialog.Root open={open} onOpenChange={changeOpen}>
      <Dialog.Trigger asChild>
        {/*
          The visible affordance — nobody discovers ⌘K from nothing. Shaped
          like the field it opens (the kit's 240px box) and on screen at every
          width: in a narrow top bar it is the glyph alone, with the words kept
          for a screen reader so the button is named by what it says. Sized by
          the top bar's container (`@container/topbar`), not the window.
        */}
        <button
          type="button"
          aria-haspopup="dialog"
          aria-keyshortcuts="Meta+K Control+K"
          className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border border-input bg-input/30 px-2.5 text-[0.8125rem] text-faint-foreground transition-colors hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring @3xl/topbar:w-60"
        >
          <IconSearch aria-hidden className="size-3.5 shrink-0" />
          <span className="flex-1 truncate text-left @max-3xl/topbar:sr-only">{placeholder}</span>
          <kbd
            aria-hidden
            className="rounded border border-border px-1.5 py-px text-[0.6875rem] @max-3xl/topbar:hidden"
          >
            {isApple ? "⌘K" : "Ctrl K"}
          </kbd>
        </button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay
          data-slot="command-palette-overlay"
          className="fixed inset-0 z-50 bg-black/60"
        />
        <Dialog.Content
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            // The whole point is typing immediately.
            e.preventDefault()
            inputRef.current?.focus()
          }}
          className="fixed left-1/2 top-[12vh] z-50 flex w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border-strong bg-surface-raised shadow-2xl focus:outline-none"
        >
          <Dialog.Title className="sr-only">Search</Dialog.Title>
          <div className="flex items-center gap-2.5 border-b border-border px-4">
            <IconSearch aria-hidden className="size-4 shrink-0 text-faint-foreground" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onInputKey}
              placeholder={placeholder}
              aria-label="Search"
              role="combobox"
              aria-expanded={shown.length > 0}
              aria-controls={LISTBOX_ID}
              aria-autocomplete="list"
              aria-activedescendant={shown[active] ? optionId(active) : undefined}
              className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-faint-foreground"
            />
            {/* Muted, not faint: faint on the raised surface fails 4.5:1 (axe). */}
            <kbd aria-hidden className="rounded border border-border px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground">
              esc
            </kbd>
          </div>

          {/* Said aloud as it changes; drawn below when there is no list. */}
          <p role="status" aria-live="polite" className="sr-only">
            {status}
          </p>

          <div id={LISTBOX_ID} role="listbox" aria-label="Results" className="max-h-[52vh] overflow-y-auto p-1.5">
            {groups.length === 0 ? (
              <p aria-hidden className="px-3 py-6 text-center text-[0.8125rem] text-muted-foreground">
                {status}
              </p>
            ) : (
              groups.map((group) => (
                <div key={group.type} role="group" aria-labelledby={`command-palette-group-${group.type}`} className="mb-1">
                  <p
                    id={`command-palette-group-${group.type}`}
                    className="px-3 py-1.5 text-[0.6875rem] font-medium uppercase tracking-[0.06em] text-muted-foreground"
                  >
                    {GROUP_LABEL[group.type]}
                  </p>
                  {group.items.map((hit) => {
                    index += 1
                    const myIndex = index
                    const Icon = ICONS[hit.type]
                    return (
                      <div
                        key={`${hit.type}-${hit.id}`}
                        id={optionId(myIndex)}
                        role="option"
                        aria-selected={myIndex === active}
                        onClick={() => go(hit)}
                        onMouseEnter={() => setActive(myIndex)}
                        className={cn(
                          "flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-left",
                          myIndex === active && "bg-accent"
                        )}
                      >
                        <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[0.8125rem] font-medium">{hit.title}</span>
                          {hit.subtitle ? (
                            <span className="block truncate text-[0.75rem] text-muted-foreground">
                              {hit.subtitle}
                            </span>
                          ) : null}
                        </span>
                      </div>
                    )
                  })}
                </div>
              ))
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
