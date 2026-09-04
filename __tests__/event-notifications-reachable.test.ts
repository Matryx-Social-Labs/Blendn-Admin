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

describe("the reminder is sent once, and by something", () => {
  /*
   * `sendEventReminders` was correct about its audience, had a cron route in
   * front of it, and **nothing called that route** — no cron block in
   * railway.json, no scheduled workflow. The one notification the product tells
   * people it sends was never sent by anything.
   *
   * It was also not idempotent, and the two defects were hiding each other: the
   * window is fifteen minutes wide, so the moment anything DID schedule it more
   * often than that, everyone would have received the same reminder on every
   * pass. Fixing the scheduler alone would have shipped the duplicate.
   */
  const code = (rel: string) =>
    readFileSync(join(__dirname, "..", rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")

  it("claims the event before sending, not after", () => {
    const src = code("lib/services/event-notifications.service.ts")

    // A conditional update on `reminded_at` is an atomic compare-and-set:
    // exactly one caller sees count === 1, including across replicas.
    expect(src).toMatch(/updateMany\(\{\s*where:\s*\{\s*id:\s*event\.id,\s*reminded_at:\s*null/)

    /*
     * Order matters and is asserted. The two ways to be wrong are not
     * symmetric: claim-then-fail costs one person one reminder, send-then-fail
     * sends the whole room a second one.
     */
    /*
     * Scoped to the function body. Comparing positions across the whole file
     * matched the `notifyEventUpdate` IMPORT at the top — so the assertion was
     * about import order, and passed or failed for reasons unrelated to the
     * thing it names.
     */
    const fn = src.slice(src.indexOf("export async function sendEventReminders"))
    const body = fn.slice(0, fn.indexOf("\nexport "))
    const claim = body.indexOf("reminded_at: null")
    const send = body.indexOf("notifyEventUpdate(")
    expect(claim).toBeGreaterThan(-1)
    expect(send).toBeGreaterThan(claim)
  })

  it("only selects events nobody has reminded", () => {
    const src = code("lib/services/event-notifications.service.ts")
    expect(src).toMatch(/reminded_at: null/)
  })

  it("is actually scheduled", () => {
    /*
     * The half that was missing entirely. In-process, matching the loops
     * already in lib/background.ts — a job that runs only if somebody
     * remembers to configure a scheduler is one that stops silently the first
     * time an environment is created without one.
     */
    const bg = code("lib/background.ts")
    expect(bg).toMatch(/startReminderSweeper\(\)/)
    expect(bg).toMatch(/stopReminderSweeper\(\)/)
  })

  it("prunes expired refresh tokens on the same pass", () => {
    // `cleanupExpiredTokens` had zero callers since it was written. A loop per
    // prune is how a process ends up with timers nobody can account for.
    expect(code("lib/reminder-sweeper.ts")).toMatch(/cleanupExpiredTokens\(\)/)
  })

  it("reaches server.ts without an @/ alias", () => {
    /*
     * This file only just became reachable from `server.ts`, and
     * `build:server` compiles with plain tsc — which emits `@/` verbatim into
     * the require() and fails at boot, in production only. The import-graph
     * guard caught it; this pins the specific file so it cannot drift back.
     */
    const src = readFileSync(
      join(__dirname, "..", "lib/services/event-notifications.service.ts"),
      "utf8"
    )
    const imports = src.split("\n").filter((l) => /^import /.test(l))
    expect(imports.some((l) => l.includes('"@/'))).toBe(false)
  })
})
