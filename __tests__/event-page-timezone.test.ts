import { readFileSync } from "fs"
import { join } from "path"

/**
 * The event page tells its times through the event's clock (SCRUM-421).
 *
 * The header formatted with a bare `Intl.DateTimeFormat`, which on a server
 * means the server's zone: an event at 04:30 IST read "23:00" on Railway. The
 * Live tab used `toLocaleTimeString`, the viewer's zone, so one page showed
 * three clocks. Both now go through `eventClock(event.timezone)`.
 */
const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8")

describe("the event page formats in the event's timezone", () => {
  const page = read("app/dashboard/events/[id]/page.tsx")
  const live = read("components/dashboard/live-tab.tsx")

  it("the page reads the event's timezone and formats through eventClock", () => {
    expect(page).toMatch(/timezone: true/)
    expect(page).toMatch(/eventClock\(event\.timezone\)/)
    expect(page).not.toMatch(/new Intl\.DateTimeFormat\(/)
  })

  it("the Live tab is handed the zone and formats nothing in the viewer's", () => {
    expect(page).toMatch(/<LiveTab[\s\S]*?timezone=\{event\.timezone\}/)
    expect(live).not.toMatch(/toLocale(Date|Time)?String\(/)
    expect(live).toMatch(/eventClock\(timezone\)/)
  })
})
