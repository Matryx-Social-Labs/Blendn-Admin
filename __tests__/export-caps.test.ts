import { readFileSync } from "fs"
import { join } from "path"

/**
 * Every CSV export has a ceiling.
 *
 * Three of the six had one and three did not — `events`, `attendees` and
 * `organisations` were unbounded `findMany`s pulled into Node, and the
 * attendees one grouped the whole result into a Map before writing a row. An
 * admin could ask a browser for the entire table.
 */

const ROOT = join(__dirname, "..")

const src = readFileSync(join(ROOT, "lib/reports.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/.*$/gm, "")

describe("no export is unbounded", () => {
  it("caps every case in the switch", () => {
    /*
     * Counted rather than named, so a seventh export cannot be added without
     * moving this number — which is the only thing that would have caught the
     * three that were missing it.
     */
    const cases = src.match(/^\s*case "[a-z-]+": \{/gm) ?? []
    const caps = src.match(/take: REPORT_ROW_LIMIT/g) ?? []
    expect(cases.length).toBe(6)
    expect(caps.length).toBe(cases.length)
  })

  it("uses one shared constant, not six literals", () => {
    /*
     * A shared name is what a seventh export has to reach for. Three literals
     * of `10_000` beside three absences is how the gap survived review.
     */
    expect(src).toMatch(/export const REPORT_ROW_LIMIT = 10_000/)
    expect(src).not.toMatch(/take: 10_?0{3}/)
  })

  it("orders the bounded exports, so the bound is meaningful", () => {
    /*
     * A truncated export of the most recent window is a usable answer. A
     * truncated export of an arbitrary slice is not, and reads identically.
     */
    const cases = src.split(/^\s*case "/m).slice(1)
    for (const block of cases) {
      if (!block.includes("take: REPORT_ROW_LIMIT")) continue
      expect(block).toMatch(/orderBy:/)
    }
  })
})
