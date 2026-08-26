import { readFileSync, readdirSync } from "fs"
import { join, relative, sep } from "path"

/**
 * Every write path that creates an event also creates its occurrences.
 *
 * ## What this is guarding against, concretely
 *
 * `resolveOccurrence` answers check-in's question "which day is this?", and it
 * returns `none` for an event with no occurrence rows. The check-in route reads
 * `none` as `too_late` and answers **"Event has already ended"** — so an event
 * three days in the future refuses check-in, and *records the refusal as
 * `too_late`*, which is a real signal on the curation-health screen.
 *
 * That is not hypothetical. `POST /api/events` called `syncOccurrences` from
 * the day it was written and the route's own comment says "every event has at
 * least one occurrence". Two later write paths to the same table did not:
 *
 *   - `app/dashboard/events/curate/actions.ts` — so **no curated event could
 *     ever be checked into**, in the one feature whose entire success metric is
 *     "did anybody get in?". The screen built to catch a wrong pin would have
 *     been reporting this instead, and reporting it as a wrong pin.
 *   - `app/api/mobile/events/[eventId]/clone/route.ts` — invisible because a
 *     clone lands as a draft, and only real once the cloner publishes, by which
 *     point nothing connects the failure to that route.
 *
 * Measured before the fix: a curated event starting in three days answered
 * `400 {"error":"Event has already ended"}`.
 *
 * ## Why a structural guard rather than a test per route
 *
 * This is the register's dominant theme — the mechanism is right and using it
 * is optional — so the thing worth pinning is not any one route's behaviour but
 * that no *new* route can skip it. A behavioural test per write path would have
 * to be remembered by the person adding the fourth one, which is exactly what
 * did not happen for the second and third.
 *
 * The check is file-scoped rather than call-scoped: each of these files creates
 * events in one place, so "this file creates events and never mentions
 * `syncOccurrences`" is precise enough to catch the real failure without
 * pretending to parse TypeScript.
 */

const ROOT = join(__dirname, "..")

function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) tsFiles(full, acc)
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) acc.push(full)
  }
  return acc
}

const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")

describe("an event is never created without its occurrences", () => {
  const files = [
    ...tsFiles(join(ROOT, "app")),
    ...tsFiles(join(ROOT, "lib")),
    ...tsFiles(join(ROOT, "scripts")),
  ]

  const creators = files.filter((f) => /db\.events\.(create|upsert)\s*\(/.test(strip(readFileSync(f, "utf8"))))

  it("finds the write paths at all", () => {
    // Guards the walker. If this drops to zero the assertion below passes
    // vacuously, which is the failure R16's recorded controls exist to catch.
    expect(creators.length).toBeGreaterThanOrEqual(3)
  })

  it("has every one of them call syncOccurrences", () => {
    const missing = creators
      .filter((f) => !/syncOccurrences\s*\(/.test(strip(readFileSync(f, "utf8"))))
      .map((f) => relative(ROOT, f).split(sep).join("/"))

    // The shape carries the hint: jest's `expect` takes one argument, and the
    // message-as-second-argument is a Playwright idiom that throws here.
    expect({
      missing,
      hint:
        missing.length > 0
          ? "This file creates events and never calls syncOccurrences. Check-in resolves the day " +
            "through event_occurrences and refuses with \"Event has already ended\" when there " +
            "are none — however far in the future the event is."
          : "",
    }).toEqual({ missing: [], hint: "" })
  })
})
