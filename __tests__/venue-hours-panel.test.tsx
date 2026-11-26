/**
 * SCRUM-1154: the venue page's Opening hours panel. Monday first, one row per
 * day; a day with no opening is Closed once any hours exist; a close past
 * midnight is said in words; every input, add and remove is named by its day;
 * no zone label.
 */
jest.mock("@/lib/venue-actions", () => ({ setVenueHours: jest.fn() }))
jest.mock("next/navigation", () => ({ useRouter: () => ({ refresh: jest.fn() }) }))

import { renderToStaticMarkup } from "react-dom/server"

import { VenueHoursPanel } from "@/app/dashboard/venues/[id]/venue-hours"

const ID = "0f546e5a-de3f-44f9-a8d0-5896752ccda0"
const WEEK = [
  { day: 2, open: "17:00", close: "23:00" },
  { day: 5, open: "18:00", close: "01:30" },
  { day: 6, open: "18:00", close: "00:00" },
]

const render = (hours: typeof WEEK | null) => renderToStaticMarkup(<VenueHoursPanel venueId={ID} hours={hours} resetHour={6} />)

describe("VenueHoursPanel", () => {
  it("lists the week from Monday, each input named by its day and holding the saved time", () => {
    const html = render(WEEK)
    const days = [...html.matchAll(/id="hours-day-(\d)"[^>]*>([A-Za-z]+)</g)].map((m) => m[2])
    expect(days).toEqual(["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"])
    expect(html).toMatch(/aria-label="Friday opens"[^>]*value="18:00"|value="18:00"[^>]*aria-label="Friday opens"/)
    expect(html).toMatch(/aria-label="Friday closes"[^>]*value="01:30"|value="01:30"[^>]*aria-label="Friday closes"/)
    expect(html).toContain('type="time"')
  })

  it("says a close past midnight in words, and midnight as midnight", () => {
    const html = render(WEEK)
    expect(html).toContain("closes Saturday morning")
    expect(html).toContain("closes at midnight")
    expect(html).not.toContain("closes Wednesday morning")
  })

  it("marks a day with no opening Closed, with an Add named by its day; each opening has a Remove named by its day", () => {
    const html = render(WEEK)
    expect((html.match(/>Closed</g) ?? []).length).toBe(4)
    expect(html).toContain('aria-label="Add Monday hours"')
    expect(html).toContain('aria-label="Remove Friday hours"')
    expect(html).not.toContain('aria-label="Add Friday hours"')
  })

  it("says hours are not given when there are none, and calls no day Closed", () => {
    const html = render(null)
    expect(html).toContain("Not given yet")
    expect(html).not.toContain(">Closed<")
    expect((html.match(/aria-label="Add \w+ hours"/g) ?? []).length).toBe(7)
  })

  it("carries no time-zone label", () => {
    expect(render(WEEK)).not.toMatch(/IST|EST|EDT|UTC|Asia\/|America\/|time zone|local time/i)
  })
})
