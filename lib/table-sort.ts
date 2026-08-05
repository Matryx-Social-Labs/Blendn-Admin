/**
 * Sorting and selection logic for the table system.
 *
 * Pure, and separated from the component because this is where the bugs are:
 * dates sorted as strings, nulls floating to the wrong end, a three-state cycle
 * that silently never reaches its third state, and a "select all matching" that
 * disagrees with what is actually selected.
 *
 * None of those look broken in a screenshot. Pinned by
 * __tests__/table-sort.test.ts.
 */

export type SortDir = "asc" | "desc"
export interface SortState {
  key: string
  dir: SortDir
}

export type SortType = "string" | "number" | "date"

/**
 * Compare two cell values.
 *
 * Nulls sort **last in both directions**. Treating null as "smallest" puts the
 * rows with missing data at the top of an ascending sort, which is the opposite
 * of useful — you sort by "last event" to find the most recent, not to find the
 * hosts who have never run one.
 */
export function compareValues(a: unknown, b: unknown): number {
  const aEmpty = a === null || a === undefined || a === ""
  const bEmpty = b === null || b === undefined || b === ""
  if (aEmpty && bEmpty) return 0
  if (aEmpty) return 1
  if (bEmpty) return -1

  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime()
  if (typeof a === "number" && typeof b === "number") return a - b
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b)

  // `numeric` so "Event 2" sorts before "Event 10" rather than after it.
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" })
}

/**
 * Nulls-last has to survive the direction flip.
 *
 * Negating the whole comparator would send empty rows to the top on a
 * descending sort, so the empty check happens before the sign is applied.
 */
export function directedCompare(a: unknown, b: unknown, dir: SortDir): number {
  const aEmpty = a === null || a === undefined || a === ""
  const bEmpty = b === null || b === undefined || b === ""
  if (aEmpty || bEmpty) return compareValues(a, b)
  return dir === "asc" ? compareValues(a, b) : -compareValues(a, b)
}

/**
 * Click cycle: unsorted → ascending → descending → unsorted.
 *
 * The third state is the one usually missing, and it is the one that lets
 * someone get back to the table's meaningful default order (oldest flag first,
 * highest supply first) after exploring.
 */
export function cycleSort(current: SortState | null, key: string): SortState | null {
  if (!current || current.key !== key) return { key, dir: "asc" }
  if (current.dir === "asc") return { key, dir: "desc" }
  return null
}

/**
 * What the header says the current state means.
 *
 * A date column reading "ascending" makes the reader do the translation; the
 * useful phrasing is what they were actually looking for.
 */
export function sortStateLabel(dir: SortDir | null, type: SortType = "string"): string | null {
  if (!dir) return null
  if (type === "date") return dir === "asc" ? "oldest first" : "newest first"
  if (type === "number") return dir === "asc" ? "lowest first" : "highest first"
  return dir === "asc" ? "A–Z" : "Z–A"
}

export interface SortableColumn<T> {
  key: string
  sortType?: SortType
  sortValue?: (row: T) => unknown
}

/** Sort a copy. Mutating the caller's array breaks React's change detection. */
export function sortRows<T extends Record<string, unknown>>(
  rows: T[],
  sort: SortState | null,
  columns: SortableColumn<T>[]
): T[] {
  if (!sort) return rows
  const column = columns.find((c) => c.key === sort.key)
  const valueOf = column?.sortValue ?? ((row: T) => row[sort.key])
  return [...rows].sort((a, b) => directedCompare(valueOf(a), valueOf(b), sort.dir))
}

/* -------------------------------------------------------------------------- */
/* Selection                                                                   */
/* -------------------------------------------------------------------------- */

export interface SelectionState {
  /** Explicitly ticked ids. Meaningless while `allMatching` is true. */
  ids: Set<string>
  /**
   * "Every row matching the current filter", including rows never rendered.
   *
   * Kept as a flag rather than by expanding to a list of ids, because the whole
   * point is that the set may be larger than what has been loaded.
   */
  allMatching: boolean
}

export const emptySelection = (): SelectionState => ({ ids: new Set(), allMatching: false })

/**
 * How many rows a bulk action will actually touch.
 *
 * The number on the bulk bar is a promise about what is about to happen, so it
 * has to be the number the action uses — not the count of ticked checkboxes
 * when "all matching" is on.
 */
export function selectionCount(state: SelectionState, totalMatching: number): number {
  return state.allMatching ? totalMatching : state.ids.size
}

export function toggleRow(state: SelectionState, id: string): SelectionState {
  const ids = new Set(state.ids)
  if (ids.has(id)) {
    ids.delete(id)
    // Un-ticking one row means the set is no longer "everything".
    return { ids, allMatching: false }
  }
  ids.add(id)
  return { ids, allMatching: state.allMatching }
}

/** The header checkbox: ticks or clears every row on the current page. */
export function togglePage(state: SelectionState, pageIds: string[]): SelectionState {
  const allOn = pageIds.length > 0 && pageIds.every((id) => state.ids.has(id))
  const ids = new Set(state.ids)
  if (allOn) {
    pageIds.forEach((id) => ids.delete(id))
    return { ids, allMatching: false }
  }
  pageIds.forEach((id) => ids.add(id))
  return { ids, allMatching: state.allMatching }
}

export type HeaderCheckState = "checked" | "indeterminate" | "unchecked"

export function headerCheckState(state: SelectionState, pageIds: string[]): HeaderCheckState {
  if (state.allMatching) return "checked"
  if (pageIds.length === 0) return "unchecked"
  const on = pageIds.filter((id) => state.ids.has(id)).length
  if (on === 0) return "unchecked"
  return on === pageIds.length ? "checked" : "indeterminate"
}

/**
 * Should the "select all N matching" escape hatch be offered?
 *
 * Only once this page is fully ticked and there is genuinely more beyond it —
 * otherwise it is a control that does nothing, which is how a user learns to
 * distrust the whole toolbar.
 */
export function canSelectAllMatching(
  state: SelectionState,
  pageIds: string[],
  totalMatching: number
): boolean {
  if (state.allMatching || pageIds.length === 0) return false
  const pageFullySelected = pageIds.every((id) => state.ids.has(id))
  return pageFullySelected && totalMatching > pageIds.length
}

/* -------------------------------------------------------------------------- */
/* Pagination                                                                  */
/* -------------------------------------------------------------------------- */

export interface PageInfo {
  page: number
  pageCount: number
  from: number
  to: number
  total: number
}

/**
 * Clamped so a filter that shrinks the result set cannot strand the viewer on
 * page 9 of 2, looking at an empty table with no clue why.
 */
export function pageInfo(total: number, page: number, pageSize: number): PageInfo {
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const clamped = Math.min(Math.max(0, page), pageCount - 1)
  return {
    page: clamped,
    pageCount,
    from: total === 0 ? 0 : clamped * pageSize + 1,
    to: Math.min((clamped + 1) * pageSize, total),
    total,
  }
}
