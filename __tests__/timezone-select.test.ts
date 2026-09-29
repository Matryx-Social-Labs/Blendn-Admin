import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { TimezoneSelect, timezoneOptions } from "@/components/event-form/timezone-select"

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
