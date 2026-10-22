import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { EventRow } from "@/components/dashboard/event-row"
import { attendanceLine, eventRowFields, type EventRowData } from "@/lib/event-row"

/*
 * The kit's EventRow, on the Events list and the overview's Coming up (step 15).
 *
 * What it gets wrong invisibly: which tab an event lands in, what the one
 * number in the attendance cell counts, and — for a venue watching somebody
 * else's night — whether a held-back count leaks as a figure or a bar.
 */

const NOW = new Date("2026-10-10T12:00:00.000Z")
const HOUR = 3_600_000

function event(overrides: Partial<Parameters<typeof eventRowFields>[0]> = {}) {
  return {
    id: "e1",
    title: "Sunset Sessions",
    status: "published" as const,
    start_time: new Date(NOW.getTime() + 48 * HOUR),
    end_time: new Date(NOW.getTime() + 52 * HOUR),
    timezone: "Asia/Kolkata",
    venue_name: "The Humming Tree",
    city: "Bengaluru",
    latitude: 12.97,
    geofence: null,
    max_capacity: 200,
    ...overrides,
  }
}

describe("eventRowFields", () => {
  it("puts a published event ahead in Upcoming", () => {
    expect(eventRowFields(event(), NOW)).toMatchObject({ phase: "upcoming", tab: "upcoming" })
  })

  it("calls a published event between its doors and its end live, in Upcoming", () => {
    const running = event({ start_time: new Date(NOW.getTime() - HOUR), end_time: new Date(NOW.getTime() + HOUR) })
    expect(eventRowFields(running, NOW)).toMatchObject({ phase: "live", tab: "upcoming" })
  })

  it("files an ended, a completed and a cancelled event under Past", () => {
    const ended = event({ start_time: new Date(NOW.getTime() - 5 * HOUR), end_time: new Date(NOW.getTime() - HOUR) })
    expect(eventRowFields(ended, NOW)).toMatchObject({ phase: "past", tab: "past" })
    expect(eventRowFields(event({ status: "cancelled" }), NOW)).toMatchObject({ phase: "past", tab: "past" })
    expect(eventRowFields(event({ status: "completed" }), NOW)).toMatchObject({ phase: "past", tab: "past" })
  })

  it("keeps a draft in Drafts whatever its date, and never calls it live", () => {
    const running = { start_time: new Date(NOW.getTime() - HOUR), end_time: new Date(NOW.getTime() + HOUR) }
    expect(eventRowFields(event({ status: "draft", ...running }), NOW)).toMatchObject({ phase: "upcoming", tab: "drafts" })
    expect(eventRowFields(event({ status: "draft" }), NOW)).toMatchObject({ tab: "drafts" })
  })

  it("marks a published event with no pin and no fence, and only a published one", () => {
    expect(eventRowFields(event({ latitude: null, geofence: null }), NOW).unfenced).toBe(true)
    expect(eventRowFields(event({ latitude: null, geofence: { type: "circle" } }), NOW).unfenced).toBe(false)
    expect(eventRowFields(event({ latitude: null, geofence: null, status: "draft" }), NOW).unfenced).toBe(false)
  })

  it("dates the tile on the event's clock, not the server's", () => {
    // 20:00 UTC on the 11th is 01:30 on the 12th in Kolkata.
    const late = event({ start_time: new Date("2026-10-11T20:00:00.000Z"), end_time: new Date("2026-10-11T23:00:00.000Z") })
    expect(eventRowFields(late, NOW)).toMatchObject({ day: "12", month: "Oct" })
  })

  it("reads no capacity as none rather than zero", () => {
    expect(eventRowFields(event({ max_capacity: 0 }), NOW).capacity).toBeNull()
    expect(eventRowFields(event({ max_capacity: null }), NOW).capacity).toBeNull()
  })
})

describe("attendanceLine", () => {
  it("counts going against capacity before the doors", () => {
    expect(attendanceLine({ phase: "upcoming", capacity: 200, going: 144, arrivals: 0 })).toEqual({
      value: 144,
      label: "of 200 going",
      pct: 72,
    })
    expect(attendanceLine({ phase: "upcoming", capacity: null, going: 12, arrivals: 0 })).toEqual({
      value: 12,
      label: "going",
      pct: null,
    })
  })

  it("counts check-ins while the night runs", () => {
    expect(attendanceLine({ phase: "live", capacity: 200, going: 212, arrivals: 138 })).toEqual({
      value: 138,
      label: "checked in",
      pct: 69,
    })
  })

  it("counts who came against who said they would, afterwards, capping the bar at full", () => {
    expect(attendanceLine({ phase: "past", capacity: 120, going: 96, arrivals: 71 })).toEqual({
      value: 71,
      label: "came · of 96 going",
      pct: 74,
    })
    // Walk-ins: 130% turn-up is a fact for the sentence, not a bar past its end.
    expect(attendanceLine({ phase: "past", capacity: null, going: 10, arrivals: 13 }).pct).toBe(100)
  })

  it("reads a held-back count and a count of nobody the same, with no bar (SCRUM-501)", () => {
    const heldBack = attendanceLine({ phase: "past", capacity: 50, going: null, arrivals: null })
    const nobody = attendanceLine({ phase: "past", capacity: 50, going: null, arrivals: 0 })
    expect(heldBack).toEqual(nobody)
    expect(heldBack).toEqual({ value: null, label: "came", pct: null })
    expect(attendanceLine({ phase: "upcoming", capacity: 50, going: null, arrivals: null })).toEqual({
      value: null,
      label: "of 50 going",
      pct: null,
    })
  })
})

describe("EventRow", () => {
  const row = (overrides: Partial<EventRowData> = {}): EventRowData => ({
    ...eventRowFields(event(), NOW),
    going: 144,
    arrivals: 0,
    ...overrides,
  })
  const html = (r: EventRowData) => renderToStaticMarkup(createElement(EventRow, { row: r }))

  it("links the whole row to the event and shows its month, title, when and where", () => {
    const out = html(row())
    expect(out).toContain('href="/dashboard/events/e1"')
    expect(out).toContain(">Oct<")
    expect(out).toContain("Sunset Sessions")
    expect(out).toContain("The Humming Tree")
    expect(out).toContain("of 200 going")
  })

  it("turns the date tile and the status to Live while the night runs", () => {
    const out = html(row({ phase: "live", arrivals: 138 }))
    expect(out).toContain(">Live<")
    expect(out).not.toContain(">Oct<")
    expect(out).toContain("checked in")
  })

  it("says Draft, and flags a published event nobody can check in to", () => {
    expect(html(row({ status: "draft", tab: "drafts" }))).toContain("Draft")
    expect(html(row({ unfenced: true }))).toContain("no fence")
    expect(html(row({ unfenced: false }))).not.toContain("no fence")
  })

  it("draws no figure and no bar width for a held-back count", () => {
    const out = html(row({ phase: "past", going: null, arrivals: null }))
    expect(out).toContain("—")
    expect(out).not.toMatch(/width:\s*\d/)
  })
})
