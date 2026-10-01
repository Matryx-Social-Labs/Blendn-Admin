import { renderToStaticMarkup } from "react-dom/server"

import { EventAttendeesCount, EventAttendeesTable } from "@/app/dashboard/events/[id]/attendees-table"
import type { EventAttendeeRow, EventAttendees } from "@/lib/attendee-roster"

/*
 * What the event's Attendees tab says for each row and each count (SCRUM-499).
 *
 * The rows come from `eventAttendees`; this holds how they read: a
 * quarter-hour window on the event's own clock, the day once it is another
 * calendar day, "Walk-in" for no RSVP, "No-show" only for a no-show, a dash
 * that a screen reader hears as "Not yet", and "held back" when fewer than
 * five came.
 */

const START = "2026-09-20T13:30:00.000Z" // 19:00 in Kolkata

const roster = (rows: EventAttendeeRow[], over: Partial<Extract<EventAttendees, { view: "labels" }>> = {}) =>
  renderToStaticMarkup(
    <EventAttendeesTable
      roster={{ view: "labels", rows, came: 6, walkIns: 1, noShows: 1, ...over }}
      timezone="Asia/Kolkata"
      startAt={START}
    />
  )

const row = (id: string, over: Partial<EventAttendeeRow>): EventAttendeeRow => ({
  id: `attendee-${id.padEnd(12, "0")}`,
  rsvp: "going",
  arrivedAt: null,
  status: "came",
  ...over,
})

it("tells an arrival as a quarter-hour window on the event's clock, with the day when it is another day", () => {
  const html = roster([
    row("a", { arrivedAt: "2026-09-20T14:15:00.000Z" }), // 19:45
    row("b", { arrivedAt: "2026-09-20T19:00:00.000Z" }), // 00:30 the next day in Kolkata
  ])
  expect(html).toContain("19:45–20:00")
  expect(html).toContain("21 Sept, 00:30–00:45")
})

it("reads each kind of row in words", () => {
  const html = roster([
    row("a", { rsvp: null, arrivedAt: "2026-09-20T14:00:00.000Z" }),
    row("b", { rsvp: "maybe", status: "no_show" }),
    row("c", { rsvp: "going", status: "expected" }),
    row("d", { rsvp: "going", status: "came", arrivedAt: null }),
  ])
  expect(html).toContain("Walk-in")
  expect(html).toContain("Maybe")
  expect(html).toContain("No-show")
  expect(html).toMatch(/<span aria-hidden="true"[^>]*>—<\/span><span class="sr-only">Not yet<\/span>/)
  expect(html).toContain(">Checked in<")
  expect(html).toContain('aria-label="Attendees of this event"')
  expect(html).toContain("arrivals to the quarter hour")
})

it("says the rows are held back, and gives no counts it would give away", () => {
  const html = roster([row("a", { status: "held_back" })], { came: 3, walkIns: null, noShows: null })
  expect(html).toContain("held back")
  expect(html).toContain("3 came: under 5, who came and when is held back")
  expect(html).not.toMatch(/walked in|no-shows/)
})

it("says what fills an empty list", () => {
  expect(roster([], { came: 0, walkIns: 0, noShows: 0 })).toContain("Nobody yet")
})

describe("the venue's count", () => {
  const count = (started: boolean, came: number | null) =>
    renderToStaticMarkup(<EventAttendeesCount started={started} came={came} />)

  it("shows the number", () => expect(count(true, 12)).toContain(">12<"))
  it("shows zero, which names nobody", () => expect(count(true, 0)).toContain(">0<"))
  it("says it is held back rather than showing a blank", () => {
    const html = count(true, null)
    expect(html).toContain("held back")
    expect(html).toContain(">—<")
  })
  it("says the doors have not opened, rather than zero", () => {
    const html = count(false, 0)
    expect(html).toContain("doors not open yet")
    expect(html).not.toContain(">0<")
  })
})
