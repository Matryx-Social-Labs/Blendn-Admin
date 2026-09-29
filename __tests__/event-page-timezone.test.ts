import { readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"

/**
 * The event's pages tell its times on the event's clock (SCRUM-421).
 *
 * The header formatted with a bare `Intl.DateTimeFormat`, which on a server
 * means the server's zone: an event at 04:30 IST read "23:00" on Railway. The
 * Live tab used `toLocaleTimeString`, the viewer's zone, so one page showed
 * three clocks. Every file under the event's route, and the live components
 * it renders, now go through `eventClock(timezone)`.
 */
const ROOT = join(__dirname, "..")
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")

function filesUnder(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const rel = join(dir, name)
    if (statSync(join(ROOT, rel)).isDirectory()) return filesUnder(rel)
    return /\.tsx?$/.test(name) ? [rel] : []
  })
}

describe("the event's pages format in the event's timezone", () => {
  const page = read("app/dashboard/events/[id]/page.tsx")

  it("the page reads the event's timezone and tells every time through its clock", () => {
    expect(page).toMatch(/timezone: true/)
    expect(page).toMatch(/eventClock\(event\.timezone\)/)
    expect(page).toMatch(/clock\.dateTime\(event\.start_time\)/)
    // Days to the doors by the event's calendar, not by 24-hour blocks.
    expect(page).toMatch(/clock\.daysUntil\(event\.start_time, now\)/)
    expect(page).not.toMatch(/86_400_000/)
  })

  it("nothing on the event's pages formats a time in the server's or the viewer's zone", () => {
    const files = [
      ...filesUnder("app/dashboard/events/[id]"),
      "components/dashboard/live-tab.tsx",
      "components/dashboard/issue-log.tsx",
      "lib/issue-timestamp.ts",
    ]
    const offenders = files.filter((f) => /Intl\.DateTimeFormat\(|toLocale(Date|Time)?String\(/.test(read(f)))
    expect(files.length).toBeGreaterThan(5)
    expect(offenders).toEqual([])
  })

  it("the Live tab is handed the zone", () => {
    expect(page).toMatch(/<LiveTab[\s\S]*?timezone=\{event\.timezone\}/)
    expect(read("components/dashboard/live-tab.tsx")).toMatch(/eventClock\(timezone\)/)
  })
})
