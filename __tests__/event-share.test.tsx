import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { DoorSlide, EventShare, fileName } from "@/components/dashboard/event-share"
import { EVENT_LINK_BASE, eventShareUrl } from "@/lib/event-share"

import { decode } from "./support/qr-decode"

/*
 * The QR & link tab (step 15, TQ-DO09 / SCRUM-538).
 *
 * The failure that looks like success: a code that scans to the wrong place,
 * or to the right place with something extra in it. So the codes on the tab
 * are decoded, not compared, and the URL is held to the id and nothing else.
 */

const ID = "3f6c1e9a-0b7d-4c2e-9a51-6d2f8e4b7c10"

describe("eventShareUrl", () => {
  it("is the event's permanent address on www: the app's own route, keyed by id", () => {
    expect(eventShareUrl(ID)).toBe(`https://www.blendn.app/event/${ID}`)
    // `www`: the apex 307s to it, and Apple and Google refuse an association
    // file behind a redirect.
    expect(EVENT_LINK_BASE.startsWith("https://www.blendn.app/")).toBe(true)
  })

  it("carries the id and nothing else: no query, no fragment, no token", () => {
    const url = new URL(eventShareUrl(ID))
    expect(url.search).toBe("")
    expect(url.hash).toBe("")
    expect(url.pathname).toBe(`/event/${ID}`)
  })

  it("cannot be bent out of its path by a strange id", () => {
    expect(new URL(eventShareUrl("a/../../f/x?y=1#z")).pathname).toBe("/event/a%2F..%2F..%2Ff%2Fx%3Fy%3D1%23z")
  })
})

describe("EventShare", () => {
  const html = (props: Partial<Parameters<typeof EventShare>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(EventShare, {
        url: eventShareUrl(ID),
        title: "Sunset Sessions at The Humming Tree",
        when: "4 Oct 2026, 15:31 · The Humming Tree",
        status: "published",
        linksLive: false,
        ...props,
      })
    )

  const slide = () =>
    renderToStaticMarkup(
      createElement(DoorSlide, { url: eventShareUrl(ID), title: "Sunset Sessions at The Humming Tree", when: "4 Oct 2026, 15:31 · The Humming Tree", linksLive: false })
    )
  // The codes, not the icons: a QR is the one `<svg role="img">` named for the event.
  const codes = (markup: string) =>
    markup
      .split("<svg")
      .slice(1)
      .map((s) => "<svg" + s)
      .filter((s) => /^<svg[^>]*role="img"[^>]*aria-label="QR code for Sunset Sessions/.test(s))

  it("draws the code on the tab and on the door slide, and both scan to the event's address", () => {
    const svgs = [...codes(html()), ...codes(slide())]
    expect(svgs).toHaveLength(2)
    for (const svg of svgs) expect(decode(svg)).toBe(`https://www.blendn.app/event/${ID}`)
  })

  it("offers the link to copy, the two downloads, the slide and the print", () => {
    const out = html()
    expect(out).toContain(`value="https://www.blendn.app/event/${ID}"`)
    for (const action of ["Copy", "Download PNG", "Download SVG", "Full-screen slide", "Print for the door"]) {
      expect(out).toContain(action)
    }
  })

  it("puts the title, when and where on the door slide, and keeps it hidden until it is shown or printed", () => {
    const out = slide()
    expect(out).toMatch(/^<div data-door-slide=""[^>]*class="hidden /)
    expect(out).toContain("Sunset Sessions at The Humming Tree")
    expect(out).toContain("4 Oct 2026, 15:31 · The Humming Tree")
  })

  it("says the link does not open the app while it does not, and stops saying so once it does", () => {
    expect(html({ linksLive: false })).toContain("does not open the app yet")
    expect(html({ linksLive: true })).not.toContain("does not open the app yet")
  })

  it("puts no 'scan to check in' on a door sign while the link opens nothing", () => {
    const sign = (linksLive: boolean) =>
      renderToStaticMarkup(createElement(DoorSlide, { url: eventShareUrl(ID), title: "T", when: "W", linksLive }))
    expect(sign(false)).not.toContain("Scan to check in")
    expect(sign(false)).toContain("find this event by its name")
    expect(sign(true)).toContain("Scan to check in")
  })

  it("tells a draft and a cancelled event what the code will do", () => {
    expect(html({ status: "draft" })).toContain("until it is published")
    expect(html({ status: "cancelled" })).toContain("This event is cancelled")
    expect(html({ status: "published" })).not.toMatch(/until it is published|is cancelled/)
  })
})

describe("fileName", () => {
  it("names a download after the event, safely", () => {
    expect(fileName("Sunset Sessions at The Humming Tree")).toBe("blendn-sunset-sessions-at-the-humming-tree-qr")
    expect(fileName("Café / Bar: ../etc")).toBe("blendn-cafe-bar-etc-qr")
    expect(fileName("!!!")).toBe("blendn-event-qr")
  })
})
