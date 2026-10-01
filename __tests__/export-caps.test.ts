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
    expect(cases.length).toBe(6)
    /*
     * Per case, not a total: check-ins has two shapes, the venue owner's
     * aggregate and everyone else's rows, and each is capped. A total would let
     * one case's second cap stand in for another case's missing one.
     */
    const blocks = src.split(/^\s*case "/m).slice(1)
    const uncapped = blocks.filter((b) => {
      const shapes = b.match(/findMany\(/g) ?? []
      const caps = b.match(/take: REPORT_ROW_LIMIT/g) ?? []
      return caps.length === 0 || caps.length < shapes.length
    })
    expect(uncapped.map((b) => b.slice(0, b.indexOf('"')))).toEqual([])
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
