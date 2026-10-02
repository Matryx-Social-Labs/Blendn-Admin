import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { moveActive, TimezoneSelect } from "@/components/event-form/timezone-select"

/*
 * The timezone picker as an ARIA combobox (step 15 review, #628).
 *
 * It had `role="combobox"` and nothing behind it: no listbox, no options, no
 * `aria-controls`, no active option, no arrow keys — and `FormControl`'s id,
 * description and error were dropped, so the label pointed at nothing and an
 * error was never read out. The markup half is held here; the keys are
 * `moveActive`, pure.
 */

describe("TimezoneSelect's text box", () => {
  const html = renderToStaticMarkup(
    createElement(TimezoneSelect, {
      value: "Asia/Kolkata",
      onChange: () => {},
      id: "tz-field",
      "aria-describedby": "tz-description tz-message",
      "aria-invalid": true,
    })
  )
  const input = html.match(/<input[^>]*>/)?.[0] ?? ""

  it("takes FormControl's id, description and error, so the label and the message reach it", () => {
    expect(input).toContain('id="tz-field"')
    expect(input).toContain('aria-describedby="tz-description tz-message"')
    expect(input).toContain('aria-invalid="true"')
  })

  it("is a combobox that owns a list, and names no active option while closed", () => {
    expect(input).toContain('role="combobox"')
    expect(input).toContain('aria-autocomplete="list"')
    expect(input).toContain('aria-expanded="false"')
    expect(input).toMatch(/aria-controls="[^"]+"/)
    expect(input).not.toContain("aria-activedescendant")
    expect(input).toContain('value="Asia/Kolkata"')
  })
})

describe("moveActive", () => {
  it("starts at the top on the first ArrowDown, and wraps at the bottom", () => {
    expect(moveActive(-1, "ArrowDown", 3)).toBe(0)
    expect(moveActive(0, "ArrowDown", 3)).toBe(1)
    expect(moveActive(2, "ArrowDown", 3)).toBe(0)
  })

  it("goes to the bottom on ArrowUp from the top or from nothing", () => {
    expect(moveActive(-1, "ArrowUp", 3)).toBe(2)
    expect(moveActive(0, "ArrowUp", 3)).toBe(2)
    expect(moveActive(2, "ArrowUp", 3)).toBe(1)
  })

  it("jumps with Home and End, leaves other keys alone, and has nothing to move to in an empty list", () => {
    expect(moveActive(1, "Home", 3)).toBe(0)
    expect(moveActive(1, "End", 3)).toBe(2)
    expect(moveActive(1, "a", 3)).toBe(1)
    expect(moveActive(1, "ArrowDown", 0)).toBe(-1)
  })
})
