import { renderToStaticMarkup } from "react-dom/server"

import { EventAttendeesCount, EventAttendeesTable } from "@/app/dashboard/events/[id]/attendees-table"
import type { EventAttendeeRow, EventAttendees } from "@/lib/attendee-roster"

/*
 * What the event's Attendees tab says for each row and each count (SCRUM-499).
 *
 * The rows come from `eventAttendees`; this holds how they read: whether each
 * came and never when (SCRUM-887), "Walk-in" for no RSVP, "No-show" only for a
 * no-show, a dash that a screen reader hears as "Not yet", and "held back"
 * when fewer than five came or the night is still settling.
 */

const roster = (rows: EventAttendeeRow[], over: Partial<Extract<EventAttendees, { view: "labels" }>> = {}) =>
  renderToStaticMarkup(
    <EventAttendeesTable roster={{ view: "labels", rows, came: 6, walkIns: 1, noShows: 1, ...over }} />
  )

const row = (id: string, over: Partial<EventAttendeeRow>): EventAttendeeRow => ({
  id: `attendee-${id.padEnd(12, "0")}`,
  rsvp: "going",
  status: "came",
  ...over,
})

it("tells whether each came, never when (SCRUM-887)", () => {
  const html = roster([row("a", {}), row("b", { rsvp: null })])
  expect(html).not.toMatch(/\d\d:\d\d/)
  expect(html).not.toContain("quarter hour")
})

it("reads each kind of row in words", () => {
  const html = roster([
    row("a", { rsvp: null }),
    row("b", { rsvp: "maybe", status: "no_show" }),
    row("c", { rsvp: "going", status: "expected" }),
    row("d", { rsvp: "going", status: "came" }),
  ])
  expect(html).toContain("Walk-in")
  expect(html).toContain("Maybe")
  expect(html).toContain("No-show")
  expect(html).toMatch(/<span aria-hidden="true"[^>]*>—<\/span><span class="sr-only">Not yet<\/span>/)
  expect(html).toContain(">Checked in<")
  expect(html).toContain('aria-label="Attendees of this event"')
  expect(html).toContain("6 came · 1 walked in · 1 no-shows")
})

it("says the rows are held back, and gives no counts it would give away", () => {
  const html = roster([row("a", { status: "held_back" })], { came: 3, walkIns: null, noShows: null })
  expect(html).toContain("held back")
  expect(html).toContain("3 came: under 5, who came is held back")
  expect(html).not.toMatch(/walked in|no-shows/)
})

it("says who came shows after the night, while it has not settled (SCRUM-887)", () => {
  const html = roster([], { came: 0, walkIns: null, noShows: null, pending: true })
  expect(html).toContain("After the night")
  expect(html).not.toContain("Nobody yet")
  expect(html).not.toContain('aria-label="Attendees of this event"')
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
