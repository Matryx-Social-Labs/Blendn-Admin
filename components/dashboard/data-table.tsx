"use client"

import Link from "next/link"
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  IconBaselineDensityMedium,
  IconBaselineDensitySmall,
  IconChevronLeft,
  IconChevronRight,
  IconColumns3,
  IconRefresh,
  IconSearch,
  IconX,
} from "@tabler/icons-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"
import {
  canSelectAllMatching,
  cycleSort,
  emptySelection,
  headerCheckState,
  pageInfo,
  selectionCount,
  sortRows,
  sortStateLabel,
  togglePage,
  toggleRow,
  type SortState,
  type SortType,
} from "@/lib/table-sort"

/**
 * The one table in the dashboard.
 *
 * It previously rendered rows and nothing else — no sorting, no selection, no
 * pagination, with `toolbar` and `footer` as empty slots waiting for someone to
 * put something in them. Attendees, moderation and all three overviews use it,
 * so every data surface in the product was un-sortable.
 *
 * Everything beyond plain rendering is **opt-in**, so the existing call sites
 * keep working untouched and adopt sorting or selection when they want it.
 *
 * Filtering, sorting and paging are client-side. At this data volume that is
 * correct — the whole table is already in memory, and a round trip per sort
 * would be slower and more code. The state shape matches what a server-side
 * implementation would need, so moving it later is a swap rather than a
 * rewrite.
 *
 * Logic lives in `lib/table-sort.ts` and is asserted there; this file is
 * rendering.
 */

export interface Column<T> {
  key: string
  label: string
  align?: "left" | "right"
  render?: (row: T) => ReactNode
  /** Hidden below the container's md breakpoint — mobile keeps the essentials. */
  secondary?: boolean
  /** Opt this column into sorting (or out, when the table is `sortable`). */
  sortable?: boolean
  sortType?: SortType
  /** Sort on this instead of the raw field — a cell rendering "3d ago" sorts on the timestamp. */
  sortValue?: (row: T) => unknown
  /** Set false to keep it out of the column menu. */
  hideable?: boolean
  /** The one column that leads each card in the mobile collapse. */
  primary?: boolean
}

export interface BulkAction {
  label: string
  icon?: ReactNode
  tone?: "default" | "destructive"
  /** Shown inline before the action fires. `{n}` is replaced with the count. */
  confirm?: string
  onAction: (ids: string[], opts: { allMatching: boolean }) => void
}

export interface TableFilter {
  key: string
  label: string
  options: { value: string; label: string }[]
}

export function DataTable<T extends { id: string | number }>({
  columns,
  rows,
  emptyState,
  toolbar,
  footer,
  rowHref,
  className,
  sortable,
  defaultSort,
  selectable,
  bulkActions = [],
  search,
  searchPlaceholder = "Search…",
  filters = [],
  pagination,
  defaultPageSize = 20,
  pageSizes = [10, 20, 50, 100],
  columnMenu,
  loading,
  error,
  onRetry,
}: {
  columns: Column<T>[]
  rows: T[]
  emptyState: ReactNode
  toolbar?: ReactNode
  footer?: ReactNode
  rowHref?: (row: T) => string
  className?: string
  sortable?: boolean
  defaultSort?: SortState
  selectable?: boolean
  bulkActions?: BulkAction[]
  /**
   * `true` filters the rows the table was given. An object submits a GET form
   * to the server instead — for a list that is a PAGE of a larger set, where
   * searching only what is loaded finds nothing past the page and says so
   * nowhere. Same slot, same look; only where the search happens changes.
   */
  search?: boolean | { name: string; defaultValue?: string }
  searchPlaceholder?: string
  filters?: TableFilter[]
  pagination?: boolean
  defaultPageSize?: number
  pageSizes?: number[]
  columnMenu?: boolean
  loading?: boolean
  error?: string
  onRetry?: () => void
}) {
  const [sort, setSort] = useState<SortState | null>(defaultSort ?? null)
  const [selection, setSelection] = useState(emptySelection)
  const [query, setQuery] = useState("")
  const [filterValues, setFilterValues] = useState<Record<string, string>>({})
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(defaultPageSize)
  const [hidden, setHidden] = useState<Set<string>>(() => new Set())
  const [compact, setCompact] = useState(false)
  const [confirming, setConfirming] = useState<BulkAction | null>(null)

  const visibleColumns = columns.filter((c) => !hidden.has(c.key))

  const filtered = useMemo(() => {
    let data = rows
    if (query.trim()) {
      const needle = query.trim().toLowerCase()
      data = data.filter((row) =>
        columns.some((c) => {
          const raw = (row as Record<string, unknown>)[c.key]
          return raw != null && String(raw).toLowerCase().includes(needle)
        })
      )
    }
    for (const f of filters) {
      const value = filterValues[f.key]
      if (value && value !== "all") {
        data = data.filter((row) => String((row as Record<string, unknown>)[f.key]) === value)
      }
    }
    return data
  }, [rows, query, filterValues, columns, filters])

  const sorted = useMemo(() => sortRows(filtered as never[], sort, columns as never[]), [
    filtered,
    sort,
    columns,
  ]) as T[]

  const info = pageInfo(sorted.length, page, pageSize)
  const visible = pagination ? sorted.slice(info.page * pageSize, (info.page + 1) * pageSize) : sorted
  const pageIds = visible.map((r) => String(r.id))

  // A filter that shrinks the results must not strand the viewer past the end.
  useEffect(() => {
    if (page !== info.page) setPage(info.page)
  }, [page, info.page])

  const activeChips = [
    ...(query.trim() ? [{ id: "q", label: `Search: ${query.trim()}`, clear: () => setQuery("") }] : []),
    ...filters
      .filter((f) => filterValues[f.key] && filterValues[f.key] !== "all")
      .map((f) => ({
        id: f.key,
        label: `${f.label}: ${
          f.options.find((o) => o.value === filterValues[f.key])?.label ?? filterValues[f.key]
        }`,
        clear: () => setFilterValues((v) => ({ ...v, [f.key]: "all" })),
      })),
  ]
  // A GET-mode search lives in the URL, not in `query`, so it has to count
  // here explicitly — otherwise a search that matched nothing rendered the
  // designed "No venues yet" empty state over a database of hundreds.
  const serverSearch = typeof search === "object" && search.defaultValue?.trim() ? search : null
  const isFiltered = activeChips.length > 0 || serverSearch !== null
  const count = selectionCount(selection, sorted.length)
  const headerState = headerCheckState(selection, pageIds)

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {toolbar}

      {search || filters.length > 0 || columnMenu ? (
        <div className="flex flex-wrap items-center gap-2">
          {typeof search === "object" ? (
            <form method="get" className="relative">
              <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint-foreground" />
              <Input
                type="search"
                name={search.name}
                defaultValue={search.defaultValue}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                className="h-9 w-56 pl-8 text-[0.8125rem]"
              />
            </form>
          ) : search ? (
            <div className="relative">
              <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint-foreground" />
              <Input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setPage(0)
                }}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                className="h-9 w-56 pl-8 text-[0.8125rem]"
              />
            </div>
          ) : null}

          {filters.map((f) => (
            <Select
              key={f.key}
              value={filterValues[f.key] ?? "all"}
              onValueChange={(v) => {
                setFilterValues((prev) => ({ ...prev, [f.key]: v }))
                setPage(0)
              }}
            >
              <SelectTrigger size="sm" className="w-auto min-w-32" aria-label={f.label}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{f.label}: all</SelectItem>
                {f.options.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ))}

          <div className="flex-1" />

          <Button
            size="sm"
            variant="outline"
            onClick={() => setCompact((c) => !c)}
            aria-pressed={compact}
            title="Row density"
          >
            {compact ? (
              <IconBaselineDensityMedium className="size-4" />
            ) : (
              <IconBaselineDensitySmall className="size-4" />
            )}
            {compact ? "Compact" : "Comfortable"}
          </Button>

          {columnMenu ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline">
                  <IconColumns3 className="size-4" /> Columns
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {columns
                  .filter((c) => c.hideable !== false)
                  .map((c) => (
                    <DropdownMenuCheckboxItem
                      key={c.key}
                      checked={!hidden.has(c.key)}
                      onCheckedChange={() =>
                        setHidden((h) => {
                          const next = new Set(h)
                          if (next.has(c.key)) next.delete(c.key)
                          else next.add(c.key)
                          return next
                        })
                      }
                    >
                      {c.label}
                    </DropdownMenuCheckboxItem>
                  ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      ) : null}

      {activeChips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {activeChips.map((chip) => (
            <span
              key={chip.id}
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border-strong bg-surface-raised py-1 pl-3 pr-1 text-[0.78125rem]"
            >
              {chip.label}
              <button
                onClick={chip.clear}
                aria-label={`Remove filter: ${chip.label}`}
                // 17px disc, 25px target: WCAG 2.5.8 wants 24, the chip wants to stay small.
                className="relative inline-flex size-[17px] items-center justify-center rounded-full bg-card text-muted-foreground after:absolute after:-inset-1 after:content-[''] hover:text-foreground"
              >
                <IconX className="size-3" />
              </button>
            </span>
          ))}
          {activeChips.length > 1 ? (
            <button
              onClick={() => {
                setQuery("")
                setFilterValues({})
              }}
              className="px-1.5 text-[0.78125rem] text-primary hover:underline"
            >
              Clear all
            </button>
          ) : null}
        </div>
      ) : null}

      {selectable && count > 0 ? (
        <div className="flex flex-wrap items-center gap-2.5 rounded-lg border border-border-strong bg-surface-raised px-3 py-2 text-[0.8125rem]">
          <span className="font-bold">{count} selected</span>
          {canSelectAllMatching(selection, pageIds, sorted.length) ? (
            <button
              onClick={() => setSelection((s) => ({ ...s, allMatching: true }))}
              className="text-primary hover:underline"
            >
              Select all {sorted.length} matching
            </button>
          ) : null}
          {selection.allMatching ? (
            <span className="text-[0.75rem] text-muted-foreground">
              all matching rows, across pages
            </span>
          ) : null}
          <div className="flex-1" />

          {confirming ? (
            <div className="flex flex-wrap items-center gap-2">
              {/* The confirm names the consequence and the count, inline —
                  there is no dialog primitive installed, and a bar that turns
                  into its own confirmation keeps the selection visible behind
                  the decision. */}
              <span className="text-[0.78125rem] text-destructive">
                {confirming.confirm?.replace("{n}", String(count))}
              </span>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => {
                  confirming.onAction([...selection.ids].map(String), {
                    allMatching: selection.allMatching,
                  })
                  setSelection(emptySelection())
                  setConfirming(null)
                }}
              >
                {confirming.label}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                Cancel
              </Button>
            </div>
          ) : (
            bulkActions.map((action) => (
              <Button
                key={action.label}
                size="sm"
                variant={action.tone === "destructive" ? "destructive" : "outline"}
                onClick={() => {
                  if (action.confirm) setConfirming(action)
                  else {
                    action.onAction([...selection.ids].map(String), {
                      allMatching: selection.allMatching,
                    })
                    setSelection(emptySelection())
                  }
                }}
              >
                {action.icon}
                {action.label}
              </Button>
            ))
          )}

          <Button
            size="icon"
            variant="ghost"
            aria-label="Clear selection"
            onClick={() => {
              setSelection(emptySelection())
              setConfirming(null)
            }}
          >
            <IconX className="size-4" />
          </Button>
        </div>
      ) : null}

      {error ? (
        <div className="flex flex-col items-center gap-2.5 rounded-lg border border-border px-5 py-8 text-center">
          <p className="text-[0.84375rem]">{error}</p>
          {onRetry ? (
            <Button size="sm" variant="outline" onClick={onRetry}>
              <IconRefresh className="size-4" /> Retry
            </Button>
          ) : null}
        </div>
      ) : loading ? (
        <div
          aria-busy="true"
          aria-label="Loading"
          className="overflow-hidden rounded-lg border border-border"
        >
          {/* A skeleton shaped like the table, not a spinner — the eye keeps
              its place when the real rows land. */}
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex gap-3 border-b border-border px-3 py-3 last:border-0">
              {visibleColumns.map((c) => (
                <span
                  key={c.key}
                  className="h-3 flex-1 animate-pulse rounded bg-surface-raised"
                  style={{ animationDelay: `${i * 80}ms` }}
                />
              ))}
            </div>
          ))}
        </div>
      ) : sorted.length === 0 && !isFiltered ? (
        emptyState
      ) : sorted.length === 0 ? (
        // Distinct from the designed empty state: nothing matches a filter the
        // user applied, and the fix is theirs to make.
        <div className="rounded-lg border border-border px-5 py-7 text-center text-[0.8125rem] text-muted-foreground">
          Nothing matches the current filters.{" "}
          {serverSearch ? (
            // The search is in the URL, so clearing it is a navigation.
            <a href="?" className="text-primary hover:underline">
              Clear search
            </a>
          ) : (
            <button
              onClick={() => {
                setQuery("")
                setFilterValues({})
              }}
              className="text-primary hover:underline"
            >
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {selectable ? (
                  <TableHead className="h-10 w-9 px-3">
                    <HeaderCheckbox
                      state={headerState}
                      onToggle={() => setSelection((s) => togglePage(s, pageIds))}
                    />
                  </TableHead>
                ) : null}
                {visibleColumns.map((column) => {
                  const canSort = column.sortable ?? sortable ?? false
                  const dir = sort?.key === column.key ? sort.dir : null
                  const label = sortStateLabel(dir, column.sortType)
                  return (
                    <TableHead
                      key={column.key}
                      aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"}
                      className={cn(
                        "h-10 px-3 text-[0.75rem] font-medium uppercase tracking-[0.06em] text-muted-foreground",
                        column.align === "right" && "text-right",
                        column.secondary && "hidden @2xl/main:table-cell"
                      )}
                    >
                      {canSort ? (
                        <button
                          onClick={() => setSort((s) => cycleSort(s, column.key))}
                          className={cn(
                            "inline-flex items-center gap-1.5 hover:text-foreground",
                            dir && "font-bold text-foreground"
                          )}
                        >
                          {column.label}
                          <SortArrows dir={dir} />
                          {label ? (
                            <span className="font-normal normal-case tracking-normal text-primary">
                              {label}
                            </span>
                          ) : null}
                        </button>
                      ) : (
                        column.label
                      )}
                    </TableHead>
                  )
                })}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((row) => {
                const id = String(row.id)
                return (
                  <TableRow
                    key={id}
                    data-state={selection.ids.has(id) || selection.allMatching ? "selected" : undefined}
                    className="border-border"
                  >
                    {selectable ? (
                      <TableCell className={cn("px-3", compact ? "py-1.5" : "py-2.5")}>
                        <Checkbox
                          checked={selection.allMatching || selection.ids.has(id)}
                          onCheckedChange={() => setSelection((s) => toggleRow(s, id))}
                          aria-label={`Select row ${id}`}
                        />
                      </TableCell>
                    ) : null}
                    {visibleColumns.map((column) => {
                      const content = column.render
                        ? column.render(row)
                        : String((row as Record<string, unknown>)[column.key] ?? "—")
                      return (
                        <TableCell
                          key={column.key}
                          className={cn(
                            "px-3 text-[0.8125rem]",
                            compact ? "py-1.5" : "py-2.5",
                            column.align === "right" && "text-right tabular-nums",
                            column.secondary && "hidden @2xl/main:table-cell"
                          )}
                        >
                          {rowHref && column.key === visibleColumns[0].key ? (
                            <Link
                              href={rowHref(row)}
                              className="font-medium hover:text-primary hover:underline"
                            >
                              {content}
                            </Link>
                          ) : (
                            content
                          )}
                        </TableCell>
                      )
                    })}
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {pagination && sorted.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3 text-[0.78125rem] text-muted-foreground">
          <label className="inline-flex items-center gap-1.5">
            Rows
            <Select
              value={String(pageSize)}
              onValueChange={(v) => {
                setPageSize(Number(v))
                setPage(0)
              }}
            >
              <SelectTrigger size="sm" className="w-auto" aria-label="Rows per page">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {pageSizes.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <div className="flex-1" />
          <span className="tabular-nums">
            {info.from}–{info.to} of {info.total}
          </span>
          <div className="flex gap-1">
            <Button
              size="icon"
              variant="outline"
              disabled={info.page === 0}
              onClick={() => setPage(info.page - 1)}
              aria-label="Previous page"
            >
              <IconChevronLeft className="size-4" />
            </Button>
            <Button
              size="icon"
              variant="outline"
              disabled={info.page >= info.pageCount - 1}
              onClick={() => setPage(info.page + 1)}
              aria-label="Next page"
            >
              <IconChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      ) : null}

      {footer ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-[0.75rem] text-faint-foreground">
          {footer}
        </div>
      ) : null}
    </div>
  )
}

/** Radix's Checkbox has no indeterminate value, so it is driven explicitly. */
function HeaderCheckbox({
  state,
  onToggle,
}: {
  state: "checked" | "indeterminate" | "unchecked"
  onToggle: () => void
}) {
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    // The visual dash for a partial page. Without it a half-selected page looks
    // identical to an empty one.
    ref.current?.setAttribute("data-indeterminate", state === "indeterminate" ? "true" : "false")
  }, [state])

  return (
    <Checkbox
      ref={ref}
      checked={state === "checked" ? true : state === "indeterminate" ? "indeterminate" : false}
      onCheckedChange={onToggle}
      aria-label="Select all on page"
    />
  )
}

function SortArrows({ dir }: { dir: "asc" | "desc" | null }) {
  return (
    <span aria-hidden className="inline-flex flex-col leading-[0.55] text-[0.5rem]">
      <span className={dir === "asc" ? "text-primary" : "text-faint-foreground"}>▲</span>
      <span className={dir === "desc" ? "text-primary" : "text-faint-foreground"}>▼</span>
    </span>
  )
}
