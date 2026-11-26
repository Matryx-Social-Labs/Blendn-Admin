/**
 * SCRUM-1154: the venue page's Opening hours panel. Monday first, one row per
 * day; a day with no opening is Closed once any hours exist; a close past
 * midnight is said in words; every input, add and remove is named by its day;
 * no zone label.
 */
jest.mock("@/lib/venue-actions", () => ({ setVenueHours: jest.fn() }))
jest.mock("next/navigation", () => ({ useRouter: () => ({ refresh: jest.fn() }) }))

import { renderToStaticMarkup } from "react-dom/server"

import { closesWords, openingToCopy, problemsOf, VenueHoursPanel, weekOf } from "@/app/dashboard/venues/[id]/venue-hours"

const ID = "0f546e5a-de3f-44f9-a8d0-5896752ccda0"
const WEEK = [
  { day: 2, open: "17:00", close: "23:00" },
  { day: 5, open: "18:00", close: "01:30" },
  { day: 6, open: "18:00", close: "00:00" },
]

const render = (hours: typeof WEEK | null, resetHour = 6) => renderToStaticMarkup(<VenueHoursPanel venueId={ID} hours={hours} resetHour={resetHour} />)

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
    // The visible "Add hours" is inside the name, so voice control by the visible label works (WCAG 2.5.3).
    expect(html).toContain('aria-label="Add hours for Monday"')
    expect(html).toContain('aria-label="Remove Friday hours"')
    expect(html).not.toContain('aria-label="Add hours for Friday"')
  })

  it("says hours are not given when there are none, and calls no day Closed", () => {
    const html = render(null)
    expect(html).toContain("Not given yet")
    expect(html).not.toContain(">Closed<")
    expect((html.match(/aria-label="Add hours for \w+"/g) ?? []).length).toBe(7)
  })

  it("carries no time-zone label", () => {
    const text = render(WEEK).replace(/<[^>]+>/g, " ")
    expect(text).not.toMatch(/\b(IST|EST|EDT|UTC)\b|Asia\/|America\/|time zone|local time/)
  })

  it("says the venue's own reset hour, not 06:00", () => {
    expect(render(WEEK, 4)).toContain("A night can run until 04:00")
  })

  it("marks a stored week the rules refuse on its field, tied to its message", () => {
    const html = render([{ day: 5, open: "05:00", close: "11:00" }])
    expect(html).toMatch(/id="hours-5-open"[^>]*aria-describedby="hours-5-error"[^>]*aria-invalid="true"|id="hours-5-open"[^>]*aria-invalid="true"/)
    expect(html).toContain('id="hours-5-error"')
    expect(html).toContain("before the venue’s day starts at 06:00")
  })

  it("keeps a stored split day's later opening, as the app shows it, and says so", () => {
    const { week, split } = weekOf([{ day: 6, open: "19:00", close: "02:00" }, { day: 6, open: "12:00", close: "15:00" }])
    expect(split).toBe(true)
    expect(week[6]).toEqual({ open: "19:00", close: "02:00" })
    expect(render([{ day: 6, open: "12:00", close: "15:00" }, { day: 6, open: "19:00", close: "02:00" }])).toContain("A day had two openings stored")
    expect(weekOf(WEEK).split).toBe(false)
  })
})

describe("the panel's rules", () => {
  const empty = () => [null, null, null, null, null, null, null] as ({ open: string; close: string } | null)[]

  it("puts each error on its own day, with a blank time ahead of the server's rules", () => {
    const week = empty()
    week[1] = { open: "", close: "23:00" }
    week[2] = { open: "05:00", close: "23:00" }
    week[5] = { open: "18:00", close: "07:00" }
    const problems = problemsOf(week, 6)
    expect([...problems.keys()].sort()).toEqual([1, 2, 5])
    expect(problems.get(1)).toEqual({ field: "open", message: "Pick when Monday opens." })
    expect(problems.get(2)?.field).toBe("open")
    expect(problems.get(5)).toMatchObject({ field: "close", message: expect.stringMatching(/^Friday runs to 07:00/) })
  })

  it("names the next day for every close past midnight, Saturday into Sunday and Sunday into Monday", () => {
    expect(closesWords(6, { open: "18:00", close: "02:00" })).toBe("closes Sunday morning")
    expect(closesWords(0, { open: "20:00", close: "01:00" })).toBe("closes Monday morning")
    expect(closesWords(2, { open: "17:00", close: "23:00" })).toBeNull()
  })

  it("starts a new day from the week's first opening, Monday first, else 18:00 to 23:00", () => {
    const week = empty()
    expect(openingToCopy(week)).toEqual({ open: "18:00", close: "23:00" })
    week[0] = { open: "12:00", close: "22:00" }
    week[3] = { open: "17:00", close: "23:00" }
    expect(openingToCopy(week)).toEqual({ open: "17:00", close: "23:00" })
  })
})
