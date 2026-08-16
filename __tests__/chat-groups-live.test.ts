import { readFileSync } from "fs"
import { join } from "path"

/**
 * `isCheckedIn` on `GET /chat/groups`.
 *
 * The app's Banter screen lifts the rooms you are standing in out of the inbox
 * and into a rail of their own. That is only honest if the flag means what it
 * says, so the two ways of getting it wrong are pinned here.
 */
const read = (...p: string[]) => readFileSync(join(__dirname, "..", ...p), "utf8")
const ROUTE = () => read("app", "api", "mobile", "chat", "groups", "route.ts")

describe("live means standing in it, not merely underway", () => {
  it("requires checked_in AND no check_out_time", () => {
    /*
     * `status: "checked_in"` alone is not enough. Check-out writes
     * `check_out_time` and the presence sweeper can lag behind it, so a row can
     * sit at `checked_in` with a departure already recorded. Requiring both
     * means the flag goes false the moment the user leaves.
     */
    const route = ROUTE()
    const block = route.slice(route.indexOf("db.event_check_ins.findMany"))
    const where = block.slice(0, block.indexOf("select:"))
    expect(where).toContain('status: "checked_in"')
    expect(where).toContain("check_out_time: null")
  })

  it("scopes to the caller", () => {
    // Without `user_id` this would report whether *anyone* is checked in, which
    // is a very different and much worse field.
    const route = ROUTE()
    const block = route.slice(route.indexOf("db.event_check_ins.findMany"))
    expect(block.slice(0, block.indexOf("select:"))).toContain("user_id: authUser.userId")
  })

  it("does not infer it from the event's clock", () => {
    /*
     * The tempting shortcut is `start_time <= now <= end_time`, which is true
     * for every member of the room whether or not they turned up. The route
     * must not compare times to decide this.
     */
    const route = ROUTE()
    const block = route.slice(route.indexOf("const eventIds"), route.indexOf("Build final response"))
    expect(block).not.toContain("start_time")
    expect(block).not.toContain("end_time")
  })
})

describe("it stays one query", () => {
  it("batches across every room rather than asking per membership", () => {
    /*
     * The rest of this route was deliberately rewritten from N*3 queries to 3
     * batched ones. A per-room check-in lookup inside the response `.map` would
     * put the N back.
     */
    const route = ROUTE()
    expect(route).toContain("event_id: { in: eventIds }")
    const build = route.slice(route.indexOf("const groupsWithUnread"))
    expect(build).not.toContain("await")
  })

  it("skips the query when there are no rooms", () => {
    // A `findMany` with `in: []` is a round trip that can only return nothing.
    expect(ROUTE()).toContain("eventIds.length > 0")
  })
})

describe("the field is declared, not just returned", () => {
  it("is in the OpenAPI schema", () => {
    // `docs/API.md` and the spec are expected to match actual route behaviour;
    // an undocumented field is one the app is not allowed to depend on.
    expect(read("lib", "openapi", "schemas", "chat.ts")).toContain("isCheckedIn: z")
  })

  it("is in docs/API.md", () => {
    expect(read("docs", "API.md")).toContain("isCheckedIn")
  })
})
