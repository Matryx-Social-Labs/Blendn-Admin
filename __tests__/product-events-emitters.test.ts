import { readFileSync } from "fs"
import { join } from "path"

/**
 * Every signal in the registry has an emitter, and the emitter is where the
 * app actually goes.
 *
 * `searched` was recorded only by `/events/search`, and the Pulse's search
 * box calls `/events?search=` — so a person searching from the app's own
 * search box never counted, and the funnel's one stream-only signal was
 * measuring a route nothing called. Driven on iOS: typed "filter", got
 * results, `product_events` gained nothing.
 */
const read = (rel: string) =>
  readFileSync(join(__dirname, "..", rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")

describe("product-event emitters sit on the routes the app calls", () => {
  it("records a search from the list route's `search=` as well as from /events/search", () => {
    const list = read("app/api/mobile/events/route.ts")
    expect(list).toContain("record({ name: PRODUCT_EVENTS.feed_browsed")
    expect(list).toMatch(/if \(parsed\.data\.search\) \{\s*record\(\{ name: PRODUCT_EVENTS\.searched/)
    expect(read("app/api/mobile/events/search/route.ts")).toContain("record({ name: PRODUCT_EVENTS.searched")
  })

  it("never records the words", () => {
    // The query text is a statement about the person. Only that they searched.
    for (const f of ["app/api/mobile/events/route.ts", "app/api/mobile/events/search/route.ts"]) {
      const src = read(f)
      const calls = src.match(/record\(\{[^}]*\}\)/g) ?? []
      for (const c of calls) expect(c).not.toMatch(/props|search[^e]/)
    }
  })
})
