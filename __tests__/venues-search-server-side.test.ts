import { readFileSync } from "fs"
import { join } from "path"

const ROOT = join(__dirname, "..")
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8")

/**
 * The venue search reaches the server.
 *
 * The admin venue index is a PAGE — `take: VENUE_INDEX_PAGE` — and its search
 * box filtered the rows the table already held. So a venue past row 200 was
 * unfindable, and the box kept saying "Search venues…" as if it had looked.
 * The same shape as `users-search-server-side.test.ts`, and the same fix: the
 * query rides the URL, and the page reads it.
 */
describe("the venue search reaches the server", () => {
  it("submits a GET form named q rather than filtering the loaded page", () => {
    const view = read("app/dashboard/venues/venue-records.tsx")
    expect(view).toMatch(/search=\{\{ name: "q", defaultValue: q \}\}/)
  })

  it("reads q off the URL and hands it to the query", () => {
    const page = read("app/dashboard/venues/page.tsx")
    expect(page).toMatch(/typeof params\.q === "string" \? params\.q\.trim\(\) : ""/)
    expect(page).toMatch(/getVenueRecords\(q\)/)
  })

  it("matches name OR city, case-insensitively, and counts the same set it lists", () => {
    const actions = read("app/dashboard/actions.ts")
    const fn = actions.slice(actions.indexOf("export async function getVenueRecords"))
    const body = fn.slice(0, fn.indexOf("\n}\n"))
    expect(body).toMatch(/name: \{ contains: q, mode: "insensitive" as const \}/)
    expect(body).toMatch(/city: \{ contains: q, mode: "insensitive" as const \}/)
    // One `where` feeds both the list and the count; two would let "Showing
    // 12 of 444" appear for a search that matched 12.
    expect(body.match(/\bwhere\b/g)?.length).toBeGreaterThanOrEqual(2)
    expect(body).not.toMatch(/count\(\{ where: \{ deleted_at: null \} \}\)/)
  })

  it("a server-side search that matches nothing is 'nothing matches', not 'no venues yet'", () => {
    // The GET input is uncontrolled, so the table's own `query` state never
    // learns about ?q. Found by the react pass: a search for a venue that does
    // not exist rendered the designed empty state over a database of hundreds.
    const table = read("components/dashboard/data-table.tsx")
    expect(table).toMatch(/const isFiltered = activeChips\.length > 0 \|\| serverSearch !== null/)
    expect(table).toMatch(/<a href="\?" className="text-primary hover:underline">/)
  })

  it("the DataTable renders the form in the search slot, not above the filters", () => {
    // Same position as the local search, so the screen does not change shape
    // between the two modes.
    const table = read("components/dashboard/data-table.tsx")
    const form = table.indexOf('<form method="get" className="relative">')
    const filters = table.indexOf("{filters.map((f) => (")
    expect(form).toBeGreaterThan(-1)
    expect(form).toBeLessThan(filters)
    expect(table).toMatch(/name=\{search\.name\}/)
  })
})
