import { readFileSync } from "fs"
import { join } from "path"

/**
 * Two unbounded fan-outs, on the two paths that run most often.
 *
 * Both are the same mistake at different scales: a per-item operation inside a
 * loop over an unbounded collection, on a path nobody thought of as a loop.
 * The feed's geocodes are gone altogether: no read geocodes now
 * (no-geocoding-on-reads.test.ts, SCRUM-1229).
 */

const ROOT = join(__dirname, "..")

const code = (rel: string) =>
  readFileSync(join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")

describe("the event city is resolved on write", () => {
  it("resolves the city at write time so the read path has one to serve", () => {
    /*
     * `resolveEventCity` was called per event on the feed and reverse-geocodes
     * through Nominatim when `city` is null — so a page of twenty null-city rows
     * fanned out twenty concurrent requests to a public API, on a user-facing
     * path, bypassing the `/api/geocode` proxy built to stop exactly that.
     *
     * It was never a read-path question: an event's city is a fact about the
     * event, decided when it is created.
     */
    expect(code("app/api/events/route.ts")).toMatch(
      /const resolvedCity = await resolveEventCity\(city, latitude, longitude\)/
    )
    // And re-resolved when the pin moves, or an event that moved across town
    // keeps the wrong label on the field the feed filters by.
    expect(code("app/api/events/[id]/route.ts")).toMatch(/const movedPin =/)
  })
})

describe("the presence sweeper is bounded, by room", () => {
  const src = code("lib/presence-sweeper.ts")
  const rooms = src.slice(src.indexOf("async function sweepRooms"), src.indexOf("export const MAX_EXPIRIES_PER_SWEEP"))

  it("takes a bounded set of events rather than every open check-in", () => {
    /*
     * The query was `findMany({ where: { status: "checked_in" } })` — every open
     * check-in on the platform, no `take`, no scope, each row dragging the
     * event's geofence JSON and the venue's, every five minutes, on the
     * Socket.io event loop.
     */
    expect(src).toMatch(/MAX_EVENTS_PER_SWEEP = 200/)
    expect(src).toMatch(/groupBy\(\{\s*by: \["event_id"\]/)
    // Each kind of room through the one bounded pass, each with its own cap (F5).
    expect(src).toMatch(/sweepRooms\(realEventsWhere, MAX_EVENTS_PER_SWEEP, now\)/)
    expect(src).toMatch(/sweepRooms\(venueDaysWhere, MAX_VENUE_DAYS_PER_SWEEP, now\)/)
    expect(rooms).toMatch(/take: cap/)
    expect(src).toMatch(/event_id: \{ in: busiest\.map/)
  })

  it("bounds events and not rows, because the guard needs a whole room", () => {
    /*
     * The mass-checkout guard reasons about the share of a room that is
     * leaving. A half-fetched event would compute that share against a partial
     * denominator and either trip on nothing or fail to trip on everything.
     *
     * Within the room pass. The venue-day expiry pass is bounded by rows on
     * purpose: an expiry is a window's end, never counted by the guard (D-20).
     */
    expect(rooms).not.toMatch(/findMany\(\{[\s\S]{0,200}status: "checked_in",[\s\S]{0,200}take:/)
  })

  it("drains oldest first, so no room is starved", () => {
    expect(src).toMatch(/orderBy: \{ _min: \{ created_at: "asc" \} \}/)
  })

  it("says so when the cap is reached", () => {
    // Not an error — the next pass continues. But a permanently full batch
    // means somebody is staying checked in longer than they should.
    expect(src).toMatch(/Presence sweep hit its event cap/)
  })
})
