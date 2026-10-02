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
    // Since step 15 the three routes under an event load it through one
    // loader and draw one header (`lib/event-page.ts`, `EventHeader`).
    const loader = read("lib/event-page.ts")
    const header = read("components/dashboard/event-header.tsx")
    expect(page).toMatch(/loadEventPage\(id\)/)
    expect(loader).toMatch(/timezone: true/)
    expect(header).toMatch(/eventClock\(event\.timezone\)/)
    expect(header).toMatch(/clock\.dateTime\(event\.start_time\)/)
    // Days to the doors by the event's calendar, not by 24-hour blocks.
    expect(header).toMatch(/clock\.daysUntil\(event\.start_time, now\)/)
    expect(header).not.toMatch(/86_400_000/)
    // The QR & link tab's "when" is the same clock.
    expect(page).toMatch(/const clock = eventClock\(event\.timezone\)/)
    expect(page).toMatch(/when=\{`\$\{clock\.dateTime\(event\.start_time\)\}/)
  })

  it("nothing on the event's pages formats a time in the server's or the viewer's zone", () => {
    const files = [
      ...filesUnder("app/dashboard/events/[id]"),
      "components/dashboard/live-tab.tsx",
      "components/dashboard/issue-log.tsx",
      "components/dashboard/event-header.tsx",
      "components/dashboard/event-share.tsx",
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

/*
 * Two screens SCRUM-421 did not reach (SCRUM-496). Placements told a sponsor
 * "Oct 1, 10:00 AM" for an event at 15:30 IST, and Chatrooms told an operator
 * a live room "ends" 5½ hours early: both are server components, and a bare
 * formatter on Railway is UTC.
 */
describe("the sponsor's Placements and the Chatrooms list use the event's clock (SCRUM-496)", () => {
  it("neither formats a time in the server's or the viewer's zone", () => {
    // The sponsor's landing page shows the same "next placement" (review pass).
    const files = [
      "app/dashboard/placements/page.tsx",
      "app/dashboard/chatrooms/page.tsx",
      "components/dashboard/overview-sponsor.tsx",
    ]
    const offenders = files.filter((f) => /Intl\.DateTimeFormat\(|toLocale(Date|Time)?String\(/.test(read(f)))
    expect(offenders).toEqual([])
  })

  it("the overview carries each event's timezone, and both pages format through eventClock", () => {
    const actions = read("lib/sponsor-actions.ts")
    const overview = actions.slice(actions.indexOf("export async function getSponsorOverview"))
    expect(overview).toMatch(/timezone: true/)
    expect(read("app/dashboard/placements/page.tsx")).toMatch(/eventClock\(p\.timezone\)/)
    expect(read("app/dashboard/placements/page.tsx")).toMatch(/eventClock\(overview\.next\.timezone\)/)
    const rooms = read("app/dashboard/chatrooms/page.tsx")
    expect(rooms).toMatch(/timezone: true/)
    expect(rooms).toMatch(/eventClock\(room\.timezone\)\.time\(room\.end_time\)/)
    expect(read("app/dashboard/actions.ts")).toMatch(/timezone: o\.next\.timezone/)
    expect(read("components/dashboard/overview-sponsor.tsx")).toMatch(/eventClock\(data\.next\.timezone\)/)
    // The Events list labels every row on its own event's clock.
    const list = read("app/dashboard/events/page.tsx")
    expect(list).toMatch(/timezone: true/)
    expect(list).toMatch(/whenLabel\(event\.start_time, event\.end_time, now, event\.timezone\)/)
  })
})

