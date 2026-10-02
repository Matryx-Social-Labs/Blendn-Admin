import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { Overview } from "@/app/dashboard/events/[id]/overview"
import type { EventOverview } from "@/lib/event-overview"

/*
 * The event's Overview tab as a venue reads another host's night (step 15).
 *
 * `getEventOverview(…, "venue")` decides the figures — ranges and dashes,
 * held in `venue-live-ranges.itest.ts`. This holds the screen to them: the
 * glance prints what it is given and nothing more, the venue's own panel says
 * what the building gets, and nothing on it edits the event.
 */

const venueOverview: EventOverview = {
  state: "upcoming",
  hero: { label: "Going", value: "Under 5", hint: "no capacity set · fewer than 5 maybe · 0 saved" },
  tiles: [
    { label: "Capacity", value: null },
    { label: "Checked in", value: "Under 5", hint: "before the doors, usually zero" },
    { label: "Room opens", value: "24h before" },
    { label: "Check-in fence", value: "60 m" },
  ],
  blockers: [],
  publishable: true,
}

const render = (canEdit: boolean) =>
  renderToStaticMarkup(
    createElement(Overview, {
      overview: venueOverview,
      eventId: "e1",
      canEdit,
      venueName: "The Humming Tree",
      attendance: null,
      connections: null,
      turnedAway: null,
    })
  )

describe("the event Overview tab, for the venue", () => {
  it("prints the glance as it was given: a range, a dash, never a count it was not sent", () => {
    const html = render(false)
    expect(html).toContain("At a glance")
    expect(html).toMatch(/<dt[^>]*>Checked in[\s\S]*?<\/dt><dd[^>]*>Under 5<\/dd>/)
    expect(html).toMatch(/<dt[^>]*>Capacity<\/dt><dd[^>]*>—<\/dd>/)
    expect(html).not.toMatch(/>\d+<\/dd>/)
  })

  it("says what the building gets, and offers nothing that edits the event", () => {
    const html = render(false)
    expect(html).toContain("Your access to this event")
    expect(html).not.toContain("Open editor")
    expect(html).not.toContain("/edit")
  })

  it("gives whoever runs it no venue panel", () => {
    expect(render(true)).not.toContain("Your access to this event")
  })
})
