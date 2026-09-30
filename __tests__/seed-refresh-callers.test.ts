import { readFileSync } from "fs"
import { join } from "path"

/**
 * Both `--refresh-times` loops go through `refreshSeededEvent` (SCRUM-482).
 * A bare slug lookup in either is the bug itself: it re-timed soft-deleted
 * events and printed them as live, and `seed-refresh.itest.ts` only exercises
 * the helper, not whether the seeds call it.
 */
function refreshTimesBody(file: string): string {
  const src = readFileSync(join(__dirname, "..", "scripts", file), "utf8")
  const start = src.indexOf("async function refreshTimes()")
  if (start === -1) return ""
  return src.slice(start, src.indexOf("\n}\n", start))
}

describe.each(["seed-qa.ts", "seed-blr-scenarios.ts"])("%s --refresh-times", (file) => {
  it("finds its events through refreshSeededEvent, never by slug alone", () => {
    const body = refreshTimesBody(file)
    expect(body).toContain("refreshSeededEvent(")
    expect(body).not.toMatch(/db\.events\.find\w*\(/)
  })
})
