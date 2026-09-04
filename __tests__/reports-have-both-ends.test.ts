import { readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"

/**
 * Every report table has a writer and a reader.
 *
 * `event_reports` had neither. It was modelled, given three indexes, and
 * connected to nothing at either end — so a person who wanted to report an
 * unsafe venue, a misleading listing or a dangerous organiser had no path at
 * all, while the schema said otherwise. `user_reports` and `message_reports`
 * spent a period with writers and no reader, which is the same defect one step
 * later: a harassment report producing a row no human would ever see.
 *
 * This is the dominant shape in this codebase — a correct mechanism with
 * nothing feeding it, or nothing reading it — and a report table is the worst
 * place for it, because the product's stated difference from an anonymous
 * board is that somebody is accountable for the room.
 *
 * Deliberately asserts BOTH ends. A writer with no reader files evidence into a
 * drawer nobody opens; a reader with no writer is a queue that is empty because
 * nothing can reach it, which looks identical to a quiet week.
 */
const ROOT = join(__dirname, "..")
const REPORT_TABLES = ["user_reports", "message_reports", "event_reports"] as const

function filesUnder(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) filesUnder(full, acc)
    else if (/\.tsx?$/.test(entry.name)) acc.push(full)
  }
  return acc
}

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")

const sources = ["app", "lib"]
  .map((d) => join(ROOT, d))
  .filter((d) => {
    try {
      return statSync(d).isDirectory()
    } catch {
      return false
    }
  })
  .flatMap((d) => filesUnder(d))
  .map((f) => ({ file: f, src: strip(readFileSync(f, "utf8")) }))

/** Comments stripped first: a table named only in prose is not a caller. */
const anyMatch = (re: RegExp) => sources.some((s) => re.test(s.src))

describe("every report table has both ends", () => {
  it("is reading real source files", () => {
    // The control: an empty file list satisfies nothing below, silently.
    expect(sources.length).toBeGreaterThan(100)
    expect(anyMatch(/db\.user_reports\.create\(/)).toBe(true)
  })

  it.each(REPORT_TABLES)("%s can be written", (table) => {
    const writer = new RegExp(`(db|tx)\\.${table}\\.(create|createMany|upsert)\\(`)
    expect({
      table,
      hasWriter: anyMatch(writer),
      hint: anyMatch(writer)
        ? ""
        : `Nothing writes ${table}. The table, its indexes and its status enum describe a ` +
          `reporting path that does not exist, and the person who needed it gets no route at all.`,
    }).toEqual({ table, hasWriter: true, hint: "" })
  })

  it.each(REPORT_TABLES)("%s is read by the admin queue", (table) => {
    const reader = new RegExp(`db\\.${table}\\.(findMany|findUnique|groupBy|count)\\(`)
    expect({
      table,
      hasReader: anyMatch(reader),
      hint: anyMatch(reader)
        ? ""
        : `Nothing reads ${table}. A report that reaches no human is worse than no report ` +
          `button, because the person who filed it believes somebody is looking.`,
    }).toEqual({ table, hasReader: true, hint: "" })
  })
})
