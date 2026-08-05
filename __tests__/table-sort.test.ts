import {
  compareValues,
  directedCompare,
  cycleSort,
  sortStateLabel,
  sortRows,
  emptySelection,
  selectionCount,
  toggleRow,
  togglePage,
  headerCheckState,
  canSelectAllMatching,
  pageInfo,
} from "@/lib/table-sort"

/**
 * The table system's logic.
 *
 * Every failure here is silent: a table that sorts *something* looks like a
 * table that sorts correctly, and a bulk bar showing the wrong count still
 * shows a count. The screenshot is identical either way, so these are asserted.
 */

describe("compareValues", () => {
  it("sorts numbers numerically, not as strings", () => {
    // The classic: "10" < "9" lexicographically.
    expect(compareValues(9, 10)).toBeLessThan(0)
    expect(compareValues(100, 20)).toBeGreaterThan(0)
  })

  it("sorts dates chronologically", () => {
    expect(compareValues(new Date("2026-01-01"), new Date("2026-06-01"))).toBeLessThan(0)
  })

  it("sorts strings with embedded numbers the way a human reads them", () => {
    // "Event 10" must come after "Event 2".
    expect(compareValues("Event 2", "Event 10")).toBeLessThan(0)
  })

  it("is case-insensitive", () => {
    expect(compareValues("apple", "Banana")).toBeLessThan(0)
  })

  it("sorts booleans false before true", () => {
    expect(compareValues(false, true)).toBeLessThan(0)
  })
})

describe("empty values sort last in BOTH directions", () => {
  // The bug this exists to prevent: sorting by "last event" ascending to find
  // the most recent, and getting a screenful of hosts who never ran one.
  it("puts null after a real value ascending", () => {
    expect(directedCompare(null, 5, "asc")).toBeGreaterThan(0)
  })

  it("puts null after a real value descending too", () => {
    expect(directedCompare(null, 5, "desc")).toBeGreaterThan(0)
  })

  it("treats undefined and empty string the same as null", () => {
    for (const empty of [null, undefined, ""]) {
      expect(directedCompare(empty, "x", "asc")).toBeGreaterThan(0)
      expect(directedCompare(empty, "x", "desc")).toBeGreaterThan(0)
    }
  })

  it("ties two empties", () => {
    expect(directedCompare(null, undefined, "asc")).toBe(0)
  })

  it("keeps real values in the sorted rows and empties at the end", () => {
    const rows = [
      { id: "a", last: null },
      { id: "b", last: 3 },
      { id: "c", last: 1 },
    ]
    const asc = sortRows(rows, { key: "last", dir: "asc" }, [{ key: "last" }])
    expect(asc.map((r) => r.id)).toEqual(["c", "b", "a"])
    const desc = sortRows(rows, { key: "last", dir: "desc" }, [{ key: "last" }])
    expect(desc.map((r) => r.id)).toEqual(["b", "c", "a"])
  })
})

describe("cycleSort — three states, and the third one exists", () => {
  it("goes unsorted → asc → desc → unsorted", () => {
    let s = cycleSort(null, "name")
    expect(s).toEqual({ key: "name", dir: "asc" })
    s = cycleSort(s, "name")
    expect(s).toEqual({ key: "name", dir: "desc" })
    s = cycleSort(s, "name")
    // Back to the table's meaningful default order. This is the state usually
    // missing, and it is the way back after exploring.
    expect(s).toBeNull()
  })

  it("starts a different column fresh at ascending", () => {
    expect(cycleSort({ key: "name", dir: "desc" }, "date")).toEqual({ key: "date", dir: "asc" })
  })
})

describe("sortStateLabel — say what the sort means, per column type", () => {
  it("phrases dates as the reader was thinking", () => {
    expect(sortStateLabel("desc", "date")).toBe("newest first")
    expect(sortStateLabel("asc", "date")).toBe("oldest first")
  })

  it("phrases numbers by magnitude", () => {
    expect(sortStateLabel("desc", "number")).toBe("highest first")
  })

  it("phrases strings alphabetically", () => {
    expect(sortStateLabel("asc", "string")).toBe("A–Z")
  })

  it("says nothing when unsorted", () => {
    expect(sortStateLabel(null)).toBeNull()
  })
})

describe("sortRows", () => {
  const rows = [
    { id: "a", name: "Charlie", n: 2 },
    { id: "b", name: "alice", n: 10 },
    { id: "c", name: "Bob", n: 1 },
  ]

  it("returns the input untouched when unsorted", () => {
    expect(sortRows(rows, null, [])).toBe(rows)
  })

  it("does not mutate the caller's array", () => {
    // Mutating in place defeats React's change detection and the table silently
    // stops re-rendering.
    const before = [...rows]
    sortRows(rows, { key: "n", dir: "asc" }, [{ key: "n" }])
    expect(rows).toEqual(before)
  })

  it("uses a column's sortValue when given", () => {
    // The rendered cell is "3d ago"; the sort has to run on the timestamp.
    const withDates = [
      { id: "a", label: "3d ago", ts: 300 },
      { id: "b", label: "1d ago", ts: 100 },
    ]
    const sorted = sortRows(withDates, { key: "label", dir: "asc" }, [
      { key: "label", sortValue: (r) => r.ts },
    ])
    expect(sorted.map((r) => r.id)).toEqual(["b", "a"])
  })

  it("falls back to the raw field with no sortValue", () => {
    expect(sortRows(rows, { key: "n", dir: "desc" }, [{ key: "n" }]).map((r) => r.id)).toEqual([
      "b",
      "a",
      "c",
    ])
  })
})

describe("selection — the count on the bulk bar is a promise", () => {
  it("counts ticked rows", () => {
    let s = emptySelection()
    s = toggleRow(s, "a")
    s = toggleRow(s, "b")
    expect(selectionCount(s, 500)).toBe(2)
  })

  it("counts every matching row once select-all-matching is on", () => {
    // The bar says "312 selected" and the action must touch 312, not the 20
    // checkboxes that happen to be ticked on this page.
    const s = { ids: new Set(["a"]), allMatching: true }
    expect(selectionCount(s, 312)).toBe(312)
  })

  it("drops out of all-matching as soon as one row is un-ticked", () => {
    // Otherwise the bar keeps claiming "all 312" while the user has explicitly
    // excluded one, and the action quietly does more than they asked.
    const s = toggleRow({ ids: new Set(["a", "b"]), allMatching: true }, "a")
    expect(s.allMatching).toBe(false)
    expect(s.ids.has("a")).toBe(false)
  })

  it("keeps all-matching when a row is added", () => {
    const s = toggleRow({ ids: new Set(["a"]), allMatching: true }, "b")
    expect(s.allMatching).toBe(true)
  })
})

describe("selection survives paging", () => {
  it("keeps page 1's ticks when page 2 is ticked", () => {
    // Losing the selection on page change is the classic version of this bug —
    // silent, and only noticed after the bulk action does too little.
    let s = togglePage(emptySelection(), ["a", "b"])
    s = togglePage(s, ["c", "d"])
    expect([...s.ids].sort()).toEqual(["a", "b", "c", "d"])
  })

  it("clears only the current page", () => {
    let s = togglePage(emptySelection(), ["a", "b"])
    s = togglePage(s, ["c", "d"])
    s = togglePage(s, ["c", "d"]) // second click on page 2 clears page 2
    expect([...s.ids].sort()).toEqual(["a", "b"])
  })

  it("leaves all-matching when a whole page is cleared", () => {
    const s = togglePage({ ids: new Set(["a", "b"]), allMatching: true }, ["a", "b"])
    expect(s.allMatching).toBe(false)
  })
})

describe("headerCheckState", () => {
  it("is unchecked with nothing selected", () => {
    expect(headerCheckState(emptySelection(), ["a", "b"])).toBe("unchecked")
  })

  it("is indeterminate with some of the page selected", () => {
    expect(headerCheckState({ ids: new Set(["a"]), allMatching: false }, ["a", "b"])).toBe(
      "indeterminate"
    )
  })

  it("is checked with the whole page selected", () => {
    expect(headerCheckState({ ids: new Set(["a", "b"]), allMatching: false }, ["a", "b"])).toBe(
      "checked"
    )
  })

  it("is checked under all-matching even on an unticked page", () => {
    expect(headerCheckState({ ids: new Set(), allMatching: true }, ["x", "y"])).toBe("checked")
  })

  it("is unchecked on an empty page rather than checked-by-vacuous-truth", () => {
    // `[].every(...)` is true, so a naive implementation renders a ticked
    // header checkbox over an empty table.
    expect(headerCheckState(emptySelection(), [])).toBe("unchecked")
  })
})

describe("canSelectAllMatching — never offer a control that does nothing", () => {
  it("offers it once the page is full and more exists beyond", () => {
    expect(canSelectAllMatching({ ids: new Set(["a", "b"]), allMatching: false }, ["a", "b"], 50)).toBe(
      true
    )
  })

  it("does not offer it when the page IS everything", () => {
    expect(canSelectAllMatching({ ids: new Set(["a", "b"]), allMatching: false }, ["a", "b"], 2)).toBe(
      false
    )
  })

  it("does not offer it with a partial page", () => {
    expect(canSelectAllMatching({ ids: new Set(["a"]), allMatching: false }, ["a", "b"], 50)).toBe(
      false
    )
  })

  it("does not offer it when already on", () => {
    expect(canSelectAllMatching({ ids: new Set(["a"]), allMatching: true }, ["a"], 50)).toBe(false)
  })
})

describe("pageInfo", () => {
  it("reports a human range", () => {
    const p = pageInfo(312, 2, 20)
    expect(p.from).toBe(41)
    expect(p.to).toBe(60)
    expect(p.pageCount).toBe(16)
  })

  it("clamps a page beyond the end rather than showing an empty table", () => {
    // Filtering 312 rows down to 5 while on page 9 would otherwise strand the
    // viewer on a blank page with no explanation.
    const p = pageInfo(5, 9, 20)
    expect(p.page).toBe(0)
    expect(p.from).toBe(1)
    expect(p.to).toBe(5)
  })

  it("handles an empty result set", () => {
    const p = pageInfo(0, 0, 20)
    expect(p.from).toBe(0)
    expect(p.to).toBe(0)
    expect(p.pageCount).toBe(1)
  })

  it("does not run past the total on the last page", () => {
    expect(pageInfo(45, 2, 20).to).toBe(45)
  })

  it("clamps a negative page", () => {
    expect(pageInfo(100, -3, 20).page).toBe(0)
  })
})
