import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { currentZoneName, TimezoneSelect, timezoneOptions, zoneForEnter } from "@/components/event-form/timezone-select"

/*
 * The event's timezone can be changed (SCRUM-453).
 *
 * The search box was a Radix PopoverTrigger's child, and the trigger gives its
 * child type="button": the DOM was <input type="button" value="Europe/Berlin">,
 * which takes no typing. The list was filtered by the query, which starts as
 * the current value, so opened it offered exactly that one zone. An admin in
 * Berlin curating a Bengaluru event could only store Europe/Berlin — found on
 * staging, where the fixture event read back as timezone=Europe/Berlin.
 */
describe("TimezoneSelect", () => {
  it("renders a search box that takes typing, not an input of type button", () => {
    const html = renderToStaticMarkup(createElement(TimezoneSelect, { value: "Europe/Berlin", onChange: () => {} }))
    const input = html.match(/<input[^>]*placeholder="Search timezone…"[^>]*>/)?.[0]
    expect(input).toBeDefined()
    expect(input).not.toMatch(/type="button"/)
  })
})

describe("timezoneOptions", () => {
  it("offers the other zones when opened on the current value", () => {
    const opened = timezoneOptions("Europe/Berlin", "Europe/Berlin")
    expect(opened.length).toBeGreaterThan(1)
  })

  it("finds a zone by part of its name, whatever the case", () => {
    expect(timezoneOptions("kolk", "Europe/Berlin")).toContain("Asia/Kolkata")
  })

  it("lists zones under their current names, not the old ones browsers still report", () => {
    // Intl.supportedValuesOf gives Asia/Calcutta and Europe/Kiev in Chrome 145 and Node 25.
    expect(timezoneOptions("calcutta", "Europe/Berlin")).toEqual([])
    expect(timezoneOptions("ky", "Europe/Berlin")).toContain("Europe/Kyiv")
  })

  it("narrows to what is typed once it differs from the current value", () => {
    expect(timezoneOptions("Berl", "Asia/Kolkata")).toEqual(["Europe/Berlin"])
  })
})

describe("zoneForEnter", () => {
  // Enter in the search box picks rather than submitting the form with the old zone.
  it("picks the first zone for what is typed", () => {
    expect(zoneForEnter("Kolk", "Europe/Berlin")).toBe("Asia/Kolkata")
  })

  it("keeps the current value when nothing new was typed or nothing matches", () => {
    expect(zoneForEnter("", "Europe/Berlin")).toBe("Europe/Berlin")
    expect(zoneForEnter("Europe/Berlin", "Europe/Berlin")).toBe("Europe/Berlin")
    expect(zoneForEnter("Atlantis", "Europe/Berlin")).toBe("Europe/Berlin")
  })
})

describe("currentZoneName", () => {
  // The curate form seeds from the browser, which reports Asia/Calcutta in India.
  it("gives the current name for an old id, and leaves others alone", () => {
    expect(currentZoneName("Asia/Calcutta")).toBe("Asia/Kolkata")
    expect(currentZoneName("Europe/Berlin")).toBe("Europe/Berlin")
  })
})
