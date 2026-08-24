import { readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"
import { materialEventChanges } from "@/lib/services/event-notifications.service"

/**
 * Cancelling an event has to tell the people who were going.
 *
 * `notifyEventCancelled` and `notifyEventDetailsChanged` were written, correct,
 * covered by their own reasoning — and called by nobody. An organiser could
 * cancel an event or move it to a different venue and the only people who found
 * out were the ones who happened to reopen the app. Both cancellation paths
 * imported `cancelEventCheckIns` and stopped there.
 *
 * That is not a bug you can see. There is no crash, no failing request, no red
 * screen: the push simply never goes, and the person shows up at a venue that
 * is closed. So the guard has to be structural.
 *
 * Comments are stripped before matching, because the failure this replaces was
 * a function whose *name* appeared in prose — a reachability check that counts
 * a mention as a caller is worse than none, since it reports green.
 */
const ROOT = join(__dirname, "..")
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8")

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
}

/** Every .ts/.tsx under app/ and lib/, excluding the module itself. */
function sourceFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue
      const abs = join(dir, entry)
      if (statSync(abs).isDirectory()) walk(abs)
      else if (/\.tsx?$/.test(entry)) out.push(abs)
    }
  }
  walk(join(ROOT, "app"))
  walk(join(ROOT, "lib"))
  return out.filter((f) => !f.endsWith("event-notifications.service.ts"))
}

/** Files that actually invoke `name(` outside a comment. */
function callersOf(name: string): string[] {
  const call = new RegExp(`\\b${name}\\s*\\(`)
  return sourceFiles()
    .filter((abs) => call.test(stripComments(readFileSync(abs, "utf8"))))
    .map((abs) => abs.slice(ROOT.length + 1))
}

describe("event notifications are reachable", () => {
  it("notifyEventCancelled is called from both cancellation paths", () => {
    const callers = callersOf("notifyEventCancelled")
    expect(callers).toContain("app/api/events/[id]/route.ts")
    expect(callers).toContain("app/api/mobile/events/[eventId]/route.ts")
  })

  it("notifyEventDetailsChanged is called from the route that can move an event", () => {
    /*
     * Dashboard only. The mobile PATCH accepts title, description and status —
     * none of which is a fact somebody leaves the house for — so it deliberately
     * does not call this.
     */
    expect(callersOf("notifyEventDetailsChanged")).toContain("app/api/events/[id]/route.ts")
  })
})

describe("the audience is intent, not a bookmark", () => {
  const SERVICE = () => read("lib/services/event-notifications.service.ts")

  it("reads event_rsvps, not only event_favorites", () => {
    /*
     * All three of these functions used to select from `event_favorites` alone.
     * A favourite is one tap on a card; an RSVP is a stated intention to be
     * somewhere. Someone who RSVP'd without favouriting — the more committed of
     * the two — was told nothing at all.
     */
    const src = stripComments(SERVICE())
    expect(src).toContain("db.event_rsvps.findMany")
  })

  it("includes waitlisted people", () => {
    /*
     * The person waiting for a seat is the one most affected when the event
     * moves or dies, and they are not `going` yet.
     */
    const committed = /const COMMITTED[^=]*=\s*\[([^\]]*)\]/.exec(stripComments(SERVICE()))
    expect(committed).not.toBeNull()
    expect(committed![1]).toContain("waitlisted")
  })

  it("deduplicates, so somebody in both tables gets one push", () => {
    expect(stripComments(SERVICE())).toContain("new Set")
  })
})

describe("materialEventChanges only fires for facts people act on", () => {
  const base = {
    start_time: new Date("2026-09-01T18:00:00Z"),
    end_time: new Date("2026-09-01T22:00:00Z"),
    venue_name: "Third Wave",
    address: "12 Church St",
  }

  it("says nothing when nothing material moved", () => {
    expect(materialEventChanges(base, { ...base })).toEqual([])
  })

  it("reports a start time change", () => {
    expect(materialEventChanges(base, { ...base, start_time: new Date("2026-09-01T19:00:00Z") })).toEqual([
      "start time",
    ])
  })

  it("reports a venue change", () => {
    expect(materialEventChanges(base, { ...base, venue_name: "Toit" })).toEqual(["venue"])
  })

  it("treats null and empty string as the same absent venue", () => {
    /*
     * Otherwise clearing a field that was already blank pushes "venue" to
     * everyone who ever saved the event.
     */
    expect(materialEventChanges({ ...base, venue_name: null }, { ...base, venue_name: "" })).toEqual([])
  })

  it("reports several changes together", () => {
    const after = { ...base, start_time: new Date("2026-09-01T19:00:00Z"), venue_name: "Toit" }
    expect(materialEventChanges(base, after)).toEqual(["start time", "venue"])
  })
})
