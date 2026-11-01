import { existsSync, readFileSync, readdirSync, statSync } from "fs"
import { join, relative } from "path"

/*
 * Structural: the launch gate has one home (`attendeeEventAccess`, `mayOpenEvent`,
 * `mayOpenCity`), so a route is covered by calling it. A new route under an event or a
 * venue must call it or say here why it does not, and a reason cannot outlive its route.
 */
const ROOT = join(__dirname, "../app/api/mobile")
const GATE = /\b(attendeeEventAccess|mayOpenEvent|mayOpenCity|inClosedCity)\b/

const IN_THE_ROOM = "needs a live check-in, whose door is gated; somebody inside keeps it when a city closes"

const NOT_THE_GATE: Record<string, string> = {
  "events/[eventId]/announce": "a host's broadcast, authorised by eventPermissions; hosts are never gated by launch state",
  "events/[eventId]/board/[postId]/block": "acts on a post already seen; safety is never gated",
  "events/[eventId]/board/[postId]/report": "acts on a post already seen; safety is never gated",
  "events/[eventId]/board/[postId]": "the author's own post, and the board read is gated",
  "events/[eventId]/chat": IN_THE_ROOM,
  "events/[eventId]/checkins": IN_THE_ROOM,
  "events/[eventId]/checkout": "leaving: refusing it would hold a person in a closed room",
  "events/[eventId]/crews/[crewId]/like": IN_THE_ROOM,
  "events/[eventId]/crews": IN_THE_ROOM,
  "events/[eventId]/friends-here": IN_THE_ROOM,
  "events/[eventId]/matches/likes": IN_THE_ROOM,
  "events/[eventId]/matches/preferences": IN_THE_ROOM,
  "events/[eventId]/matches": IN_THE_ROOM,
  "events/[eventId]/peer-ratings": "about a night the person already attended",
  "events/[eventId]/people": IN_THE_ROOM,
  "events/[eventId]/polls/[pollId]": IN_THE_ROOM,
  "events/[eventId]/polls/[pollId]/vote": IN_THE_ROOM,
  "events/[eventId]/presence": IN_THE_ROOM,
  "events/[eventId]/report": "safety is never gated",
  "events/[eventId]/waves": IN_THE_ROOM,
}

function routesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return routesUnder(path)
    return name === "route.ts" ? [relative(ROOT, dir)] : []
  })
}

const routes = [...routesUnder(join(ROOT, "events/[eventId]")), ...routesUnder(join(ROOT, "venues/[venueId]"))]
const read = (route: string) => readFileSync(join(ROOT, route, "route.ts"), "utf8")

describe("the launch gate on routes by id", () => {
  it("finds the routes", () => {
    expect(routes).toEqual(expect.arrayContaining(["events/[eventId]", "events/[eventId]/rsvp", "venues/[venueId]/regular"]))
  })

  it("every route calls the gate or is named with a reason", () => {
    expect(routes.filter((r) => !GATE.test(read(r)) && !(r in NOT_THE_GATE))).toEqual([])
  })

  it("no reason outlives its route or its need", () => {
    const stale = Object.keys(NOT_THE_GATE).filter((r) => !existsSync(join(ROOT, r, "route.ts")) || GATE.test(read(r)))
    expect(stale).toEqual([])
  })

  it("the two gates themselves still hold it", () => {
    const access = readFileSync(join(__dirname, "../lib/event-access.ts"), "utf8")
    expect(access).toMatch(/await mayOpenEvent\(userId, eventId, event\.city\)/)
    expect(read("events/[eventId]/checkin")).toMatch(/await mayOpenEvent\(authUser\.userId, eventId, event\.city\)/)
  })
})
