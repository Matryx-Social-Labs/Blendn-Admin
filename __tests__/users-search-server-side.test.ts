import { readFileSync } from "fs"
import { join } from "path"

import { rowCountLabel } from "@/lib/row-count-label"

/**
 * The users search box asks the server, and the page admits its cap.
 *
 * `getUsers` has always taken a `search` argument and built an insensitive
 * `contains` over name and email, and `page.tsx` has always read `?search=` off
 * the URL and passed it through. **Nothing ever set that param.** The input
 * called `table.getColumn("user").setFilterValue(...)` — a TanStack filter over
 * the rows already fetched — and the fetch is capped at 50.
 *
 * With 120 accounts on staging, searching for a real user outside the newest 50
 * returned *"No users found."* A correct server-side search with no caller, and
 * a box quietly answering a narrower question than the one it was asked.
 *
 * The same page also declared `total` on its props and read it nowhere, so a
 * view of 50 of 120 said only "50 row(s)" and looked complete. That is the *no
 * silent caps* rule, unapplied to the screen it was written for.
 *
 * Read as source text rather than rendered: this is wiring, and the thing worth
 * pinning is which mechanism the input reaches for. A render test would assert
 * the box exists, which was never in doubt.
 */
const ROOT = join(__dirname, "..")

const src = readFileSync(join(ROOT, "app/dashboard/users/users-table.tsx"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/\/\/.*$/gm, "")

describe("the users search reaches the server", () => {
  it("found the file, so the assertions below are not vacuous", () => {
    expect(src).toContain("export function UsersTable")
    expect(src).toContain('placeholder="Search users..."')
  })

  it("drives the search off the URL, which is what page.tsx reads", () => {
    /*
     * Both halves pinned. `useSearchParams` alone would pass against a
     * component that reads the param and still filters locally.
     */
    expect(src).toContain('params.get("search")')
    expect(src).toContain('next.set("search", searchText)')
  })

  it("does not filter the fetched page instead", () => {
    // The mechanism that made a correct server search unreachable.
    expect(src).not.toContain("setFilterValue")
  })

  it("hands the footer the real total, not just the page size", () => {
    /*
     * The wiring half only. What the sentence *says* is asserted below against
     * the function itself, because the first version of this guard checked for
     * the text `data.length < total` and **passed against
     * `{false && data.length < total}`** — it saw the rule written down and
     * could not see it disabled.
     */
    expect(src).toContain("rowCountLabel({")
    expect(src).toContain("total,")
  })
})

describe("a capped table says so", () => {
  const base = { searching: false, selected: 0, onPage: 10 }

  it("discloses the cap when there is more than was fetched", () => {
    expect(rowCountLabel({ ...base, shown: 50, total: 120 })).toBe(
      "Showing 50 of 120 — search to reach the rest."
    )
  })

  it("counts the matches when a search is running", () => {
    /*
     * "search to reach the rest" would be useless advice to somebody already
     * searching, and a bare "50 of 120" during a search reads as the cap rather
     * than as how many matched.
     */
    expect(rowCountLabel({ ...base, shown: 50, total: 120, searching: true })).toBe(
      "Showing 50 of 120 matching."
    )
  })

  it("falls back to the selection count when nothing is hidden", () => {
    expect(rowCountLabel({ shown: 12, total: 12, searching: false, selected: 3, onPage: 10 })).toBe(
      "3 of 10 row(s) selected."
    )
  })

  it("does not claim a cap when the page is the whole set", () => {
    // The boundary: equal is complete, and `shown` can never exceed `total`.
    expect(rowCountLabel({ ...base, shown: 120, total: 120 })).not.toContain("Showing")
  })
})
