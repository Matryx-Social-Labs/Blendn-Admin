import { readFileSync } from "fs"
import { join } from "path"

/**
 * A filter that selects nothing is a control with nothing behind it.
 *
 * `DataTable` filters with `String(row[key]) === value`, so a `TableFilter`
 * keyed on a field that does not exist on the row — or on one whose values are
 * not the option values — renders a working-looking dropdown that changes
 * nothing. The first version of the venue index's Ownership filter was keyed on
 * `owner`, whose values are organisation names and `null`, with options
 * `__unclaimed__` / `__claimed__`. It filtered nothing.
 *
 * `docs/ROADMAP.md` names this anti-pattern directly: ship the UI *with* the
 * logic. It is worse than a missing feature, because it looks present.
 */
const ROOT = join(__dirname, "..")
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8")

/** Option values a `filters={[…]}` block offers, keyed by filter key. */
function filterOptions(src: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const block of src.matchAll(/key:\s*"(\w+)",\s*\n\s*label:[^\n]*\n\s*options:\s*\[([\s\S]*?)\],/g)) {
    out.set(block[1], [...block[2].matchAll(/value:\s*"([^"]*)"/g)].map((m) => m[1]))
  }
  return out
}

describe("the venue index's filters actually filter", () => {
  it("keys Ownership on a field the row carries, with matching values", () => {
    const options = filterOptions(read("app/dashboard/venues/venue-records.tsx"))
    expect([...options.keys()]).toContain("ownership") // guards the guard

    // `owner` holds organisation names and null. Filtering on it can only ever
    // match a literal name, which is why the control was dead.
    expect(options.has("owner")).toBe(false)
    expect(options.get("ownership")?.sort()).toEqual(["claimed", "unclaimed"])
  })

  it("has the server produce exactly those values", () => {
    /*
     * The other half. Matching option values against a field that exists is not
     * enough — the field has to hold these strings. `getVenueRecords` derives
     * `ownership` from `owner_org`, and the type pins the union.
     */
    const actions = read("app/dashboard/actions.ts")
    expect(actions).toMatch(
      /ownership: venue\.owner_org \? \("claimed" as const\) : \("unclaimed" as const\)/
    )
    expect(read("lib/dashboard-types.ts")).toMatch(/ownership: "claimed" \| "unclaimed"/)
  })

  it("bounds the query and hands the total back so the cap can be stated", () => {
    // 395 rows and a 15,812px document, with no search and no pagination.
    const actions = read("app/dashboard/actions.ts")
    expect(actions).toMatch(/take: VENUE_INDEX_PAGE/)
    expect(actions).toMatch(/Promise<\{ venues: VenueRecordRow\[\]; total: number \}>/)
    const view = read("app/dashboard/venues/venue-records.tsx")
    expect(view).toMatch(/venues\.length < total/)
    expect(view).toMatch(/\bsearch\b/)
    expect(view).toMatch(/\bpagination\b/)
  })
})
