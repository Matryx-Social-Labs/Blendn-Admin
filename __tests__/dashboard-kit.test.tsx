import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { EventTabs } from "@/app/dashboard/events/[id]/event-tabs"
import { KpiStrip, Locked } from "@/components/dashboard/kit"
import { QR } from "@/components/dashboard/qr-code"

import { decode, grid } from "./support/qr-decode"

/*
 * The three kit components whose failure is invisible on screen.
 *
 * A locked tile that renders its value under the lock, or a preview fed the
 * organisation's real numbers, looks exactly like a correct one — the blur and
 * the lock icon are still there. And a QR code that encodes the wrong string
 * still looks like a QR code. Each is asserted on the output, not the styling.
 */

describe("KpiStrip", () => {
  const strip = (items: Parameters<typeof KpiStrip>[0]["items"]) =>
    renderToStaticMarkup(createElement(KpiStrip, { items }))

  it("renders an open tile's value", () => {
    expect(strip([{ label: "Turn-up", value: "73%" }])).toContain("73%")
  })

  it("renders no value on a locked tile, even when one reaches it", () => {
    /*
     * `LockedKpi` has no `value` field, so this needs a cast — which is the
     * case worth testing: a spread of the open tile's props onto a locked one
     * typechecks the moment someone widens the type, and the number would then
     * sit in the HTML under a lock icon.
     */
    const html = strip([
      { label: "Often no-show", locked: true, value: 9137, hint: "real hint 4242" } as never,
    ])
    expect(html).toContain("Often no-show")
    expect(html).toContain("Unlock with Analytics")
    expect(html).not.toContain("9137")
    expect(html).not.toContain("4242")
  })

  it("names the plan on a locked tile", () => {
    expect(strip([{ label: "Came back", locked: true }])).toContain("Analytics")
  })
})

describe("Locked", () => {
  const render = (props: Parameters<typeof Locked>[0]) =>
    renderToStaticMarkup(createElement(Locked, props))

  it("draws the sample it is given, hidden from assistive tech, behind the pitch", () => {
    const html = render({
      title: "See whether people met",
      body: "Connections, repeat attendance and turn-up, per event.",
      sample: createElement("span", null, "SAMPLE-ROW"),
    })
    expect(html).toContain("SAMPLE-ROW")
    expect(html).toMatch(/<div aria-hidden="true" inert="" data-locked-sample=""[^>]*>[^]*SAMPLE-ROW/)
    expect(html).toContain("See whether people met")
  })

  it("has no prop that carries real data", () => {
    /*
     * The type is the guard: a preview fed the org's own rows would sidestep
     * the suppression floors and put paid numbers in the page source. If a
     * `data`, `value` or `rows` prop is ever added, these lines stop erroring
     * and `tsc --noEmit` fails on the unused directives (TS2578). Not jest:
     * ts-jest only transpiles here (`isolatedModules`), so the lint/tsc step
     * is what enforces this one.
     */
    const base = { title: "t", body: "b", sample: null }
    // @ts-expect-error -- no real-data path into Locked
    void createElement(Locked, { ...base, data: [1, 2, 3] })
    // @ts-expect-error -- no real-data path into Locked
    void createElement(Locked, { ...base, value: 42 })
    // @ts-expect-error -- no real-data path into Locked
    void createElement(Locked, { ...base, rows: [] })
    // @ts-expect-error -- the sample is required: there is no "fetch it yourself" mode
    void createElement(Locked, { title: "t", body: "b" })
  })
})

describe("QR", () => {
  const render = (value: string) =>
    renderToStaticMarkup(createElement(QR, { value, label: "QR code to check in" }))

  it("encodes the URL it is given", () => {
    const url = "https://blendn.app/e/sunset-sessions?src=qr"
    expect(decode(render(url))).toBe(url)
  })

  it("encodes a different URL differently", () => {
    // The control: a decoder that returned a constant would pass the one above.
    const other = "https://blendn.app/e/another-night"
    expect(decode(render(other))).toBe(other)
  })

  it("keeps the standard's four-module quiet zone on every side", () => {
    const g = grid(render("https://blendn.app/e/sunset-sessions"))!
    expect(g.runs.length).toBeGreaterThan(50)
    const left = Math.min(...g.runs.map((r) => r.x))
    const top = Math.min(...g.runs.map((r) => r.y))
    const right = g.side - Math.max(...g.runs.map((r) => r.x + r.len))
    const bottom = g.side - 1 - Math.max(...g.runs.map((r) => r.y))
    expect({ left, top, right, bottom }).toEqual({ left: 4, top: 4, right: 4, bottom: 4 })
  })

  it("is SVG elements named by its label, never injected markup", () => {
    const html = render("https://blendn.app/e/x\"><script>alert(1)</script>")
    expect(html).not.toContain("<script>")
    expect(html).toMatch(/<svg[^>]*role="img"[^>]*aria-label="QR code to check in"/)
  })
})

describe("PillTabs, through EventTabs", () => {
  const html = renderToStaticMarkup(
    createElement(EventTabs, {
      eventId: "e1",
      active: "attendees",
      tabs: [
        { key: "overview", label: "Overview" },
        { key: "live", label: "Live" },
        { key: "attendees", label: "Attendees" },
        { key: "chat", label: "Chat" },
        { key: "feedback", label: "Feedback" },
      ],
    })
  )

  it("is a named nav of links, each to its own URL", () => {
    expect(html).toMatch(/<nav[^>]*aria-label="Event sections"/)
    const hrefs = [...html.matchAll(/<a[^>]*href="([^"]+)"/g)].map((m) => m[1])
    expect(hrefs).toEqual([
      "/dashboard/events/e1",
      "/dashboard/events/e1?tab=live",
      "/dashboard/events/e1?tab=attendees",
      "/dashboard/events/e1/messaging",
      "/dashboard/events/e1/feedback",
    ])
  })

  it("marks only the active tab as the current page", () => {
    const current = [...html.matchAll(/<a[^>]*aria-current="page"[^>]*>([^<]+)/g)].map((m) => m[1])
    expect(current).toEqual(["Attendees"])
  })

  it("puts the live dot on Live and nowhere else, hidden from a screen reader", () => {
    const live = html.match(/>Live<span aria-hidden="true"[^>]*animate-pulse/)
    expect(live).not.toBeNull()
    expect(html.match(/animate-pulse/g)).toHaveLength(1)
  })
})
