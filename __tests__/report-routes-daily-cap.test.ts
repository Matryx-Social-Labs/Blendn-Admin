import { readdirSync, readFileSync, statSync } from "fs"
import { join } from "path"

/*
 * API M8 (security audit): the per-minute `safety` limit stops a burst, not a
 * patient script filing ~28k reports a day into a queue that shows the oldest
 * hundred. Every route that files a report carries the `reportDay` allowance,
 * so a new one cannot ship without it.
 */
const MOBILE = join(__dirname, "..", "app", "api", "mobile")

function reportRoutes(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return reportRoutes(path)
    return name === "route.ts" && dir.endsWith("report") ? [path] : []
  })
}

describe("report routes", () => {
  const routes = reportRoutes(MOBILE)

  it("finds the report routes (the guard is not vacuous)", () => {
    expect(routes.length).toBeGreaterThanOrEqual(9)
  })

  it.each(routes.map((r) => [r.slice(MOBILE.length)]))("%s applies the daily report cap", (route) => {
    expect(readFileSync(join(MOBILE, route), "utf8")).toContain('userLimit("reportDay"')
  })
})
