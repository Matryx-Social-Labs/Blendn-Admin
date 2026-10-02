import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { DoorSlide, EventShare, fileName } from "@/components/dashboard/event-share"
import { EVENT_LINK_BASE, eventShareUrl } from "@/lib/event-share"

import { decode } from "./support/qr-decode"

/*
 * The QR & link tab (step 15, TQ-DO09 / SCRUM-538).
 *
 * The failure that looks like success: a code that scans to the wrong place,
 * or to the right place with something extra in it — or a door sign that
 * sends people to a page that is not there yet. So the codes are decoded, not
 * compared, the URL is held to the id and nothing else, and the slide is held
 * to showing no code while the link opens nothing.
 */

const ID = "3f6c1e9a-0b7d-4c2e-9a51-6d2f8e4b7c10"
const TITLE = "Sunset Sessions at The Humming Tree"
const WHEN = "4 Oct 2026, 15:31 · The Humming Tree"

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

// The codes, not the icons: a QR is the one `<svg role="img">` named for the event.
const codes = (markup: string) =>
  markup
    .split("<svg")
    .slice(1)
    .map((s) => "<svg" + s)
    .filter((s) => /^<svg[^>]*role="img"[^>]*aria-label="QR code for Sunset Sessions/.test(s))

describe("EventShare", () => {
  const html = (linksLive = false) =>
    renderToStaticMarkup(createElement(EventShare, { url: eventShareUrl(ID), title: TITLE, when: WHEN, linksLive }))

  it("draws the code on the tab, and it scans to the event's address", () => {
    const svgs = codes(html())
    expect(svgs).toHaveLength(1)
    expect(decode(svgs[0])).toBe(`https://www.blendn.app/event/${ID}`)
  })

  it("offers the link to copy, the two downloads, the slide and the print", () => {
    const out = html()
    expect(out).toContain(`value="https://www.blendn.app/event/${ID}"`)
    for (const action of ["Copy", "Download PNG", "Download SVG", "Full-screen slide", "Print for the door"]) {
      expect(out).toContain(action)
    }
  })

  it("keeps no canvas mounted: the PNG is drawn on click, at its own size", () => {
    expect(html()).not.toContain("<canvas")
  })

  it("says the link does not open the app while it does not, and stops saying so once it does", () => {
    expect(html(false)).toContain("does not open the app yet")
    expect(html(true)).not.toContain("does not open the app yet")
  })
})

describe("DoorSlide", () => {
  const slide = (linksLive: boolean) =>
    renderToStaticMarkup(createElement(DoorSlide, { url: eventShareUrl(ID), title: TITLE, when: WHEN, linksLive }))

  it("puts no code and no address on the door while the link opens nothing, and says to find the event by name", () => {
    const sign = slide(false)
    expect(codes(sign)).toHaveLength(0)
    expect(sign).not.toContain("www.blendn.app")
    expect(sign).not.toContain("Scan to check in")
    expect(sign).toContain("find this event by its name")
  })

  it("puts the code at the size of the screen once the link is live, and it scans to the event", () => {
    const svgs = codes(slide(true))
    expect(svgs).toHaveLength(1)
    expect(decode(svgs[0])).toBe(`https://www.blendn.app/event/${ID}`)
    expect(slide(true)).toContain("Scan to check in")
  })

  it("is a named dialog that takes focus, hidden until shown or printed, with the title, when and where", () => {
    const out = slide(true)
    expect(out).toMatch(
      /^<div data-door-slide="" role="dialog" aria-modal="true" aria-label="Door slide for Sunset Sessions at The Humming Tree" tabindex="-1" class="relative hidden /
    )
    expect(out).toContain(TITLE)
    expect(out).toContain(WHEN)
    expect(out).toContain(">Close</button>")
  })
})

describe("fileName", () => {
  it("names a download after the event, safely", () => {
    expect(fileName(TITLE)).toBe("blendn-sunset-sessions-at-the-humming-tree-qr")
    expect(fileName("Café / Bar: ../etc")).toBe("blendn-cafe-bar-etc-qr")
    expect(fileName("!!!")).toBe("blendn-event-qr")
  })
})
