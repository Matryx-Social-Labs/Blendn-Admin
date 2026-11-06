import { renderToStaticMarkup } from "react-dom/server"

import { counterTone, failureFor, fitNote, LobbyNotePanel, type LobbyNoteProps } from "@/app/dashboard/events/[id]/lobby-note"
import { lobbyMoment, updatedAgo } from "@/lib/dashboard-format"

import { WORST } from "./support/long-text"

/*
 * The Lobby note panel (SCRUM-1026; mockup lobby-pin-20261106/finalized.html):
 * one pinned note, the Lobby's clock beside it, the next change its only
 * bright word. Server-given states render here; the editing, clearing and
 * failing states are their pure pieces plus the browser drive.
 */

const base: LobbyNoteProps = {
  eventId: "e1",
  host: "Nightshift Collective",
  note: { body: "Music starts at 6. Entry is from the side lane on 15th Cross.", updatedAt: "2026-11-06T07:00:00.000Z" },
  state: "open",
  doors: "Sun 8 Nov, 4:30 PM",
  closes: "Tue 10 Nov, 12 AM",
  now: "2026-11-06T10:00:00.000Z",
}
const render = (over: Partial<LobbyNoteProps> = {}) => renderToStaticMarkup(<LobbyNotePanel {...base} {...over} />)
/** The class list of the element that directly holds `text`. */
const classOf = (html: string, text: string) => {
  const at = html.indexOf(`>${text.replaceAll("&", "&amp;")}<`)
  expect(at).toBeGreaterThan(-1)
  return /class="([^"]*)"[^>]*$/.exec(html.slice(html.lastIndexOf("<", at), at))?.[1] ?? ""
}

describe("written, Lobby open", () => {
  const html = render()

  it("names the host as the app shows it, never a person, with the Host label", () => {
    expect(html).toContain("Shown in the app as")
    expect(html).toContain(">Nightshift Collective<")
    expect(html).toContain(">Host<")
  })

  it("shows the note, when it changed and its length, with Edit note and Clear", () => {
    expect(html).toContain("Music starts at 6.")
    expect(html).toContain("Updated 3 h ago")
    expect(html).toContain("61 / 500")
    expect(html).toContain(">Edit note<")
    expect(html).toContain(">Clear<span class=\"sr-only\"> the Lobby note</span>")
  })

  it("puts the Lobby's clock beside it: Open now, doors the bright word", () => {
    expect(html).toContain('aria-label="The Lobby’s clock"')
    expect(html).toContain(">Now<")
    expect(classOf(html, "From Sun 8 Nov, 4:30 PM")).toContain("text-primary")
    expect(classOf(html, "Tue 10 Nov, 12 AM")).not.toContain("text-primary")
  })

  it("keeps line breaks and wraps a note with no spaces", () => {
    expect(classOf(render({ note: { ...base.note!, body: "Line one" } }), "Line one")).toEqual(expect.stringContaining("whitespace-pre-wrap"))
    expect(classOf(html, base.note!.body)).toContain("[overflow-wrap:anywhere]")
  })
})

describe("nothing pinned", () => {
  const html = render({ note: null })

  it("is the field itself, labelled with the question, and Pin to the Lobby waits for text", () => {
    expect(html).toContain("What should everyone going know?")
    expect(html).toMatch(/<textarea[^>]*id="[^"]+"/)
    expect(html).toContain("0 / 500")
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Pin to the Lobby<\/button>/)
    expect(html).not.toContain(">Edit note<")
  })
})

describe("after doors (read-only), still editable", () => {
  const html = render({ state: "read_only" })

  it("moves the clock on: Open until doors, read-only from doors, the close the bright word", () => {
    expect(html).toContain("Until Sun 8 Nov, 4:30 PM")
    expect(classOf(html, "From Sun 8 Nov, 4:30 PM")).not.toContain("text-primary")
    expect(classOf(html, "Tue 10 Nov, 12 AM")).toContain("text-primary")
    expect(html).toContain(">Edit note<")
  })
})

describe("closed", () => {
  it("keeps the note faint, says nobody sees it, and offers nothing", () => {
    const html = render({ state: "closed" })
    expect(classOf(html, base.note!.body)).toContain("text-faint-foreground")
    expect(html).toContain("The Lobby closed Tue 10 Nov, 12 AM. Nobody sees this note in the app now.")
    expect(html).not.toContain(">Edit note<")
    expect(html).not.toContain(">Clear<")
    expect(html).not.toContain("text-primary")
  })

  it("with nothing pinned, says so without a field", () => {
    const html = render({ state: "closed", note: null })
    expect(html).not.toContain("<textarea")
    expect(html).toContain("Nothing was pinned. The Lobby closed Tue 10 Nov, 12 AM.")
  })
})

describe("long text", () => {
  it.each([WORST.firstNameDevanagari, "Kerala Design Week & Friends of the Riso Collective"])("a host name of %s wraps in the byline", (host) => {
    expect(classOf(render({ host }), host)).toContain("[overflow-wrap:anywhere]")
  })

  it("counts a 500-emoji note as 500, as the database does", () => {
    expect(render({ note: { body: "🎉".repeat(500), updatedAt: base.now } })).toContain("500 / 500")
  })
})

describe("the field's pieces", () => {
  it("stops at 500 characters, counted as code points, never halving an emoji", () => {
    expect(fitNote("🎉".repeat(600))).toBe("🎉".repeat(500))
    expect(fitNote("x".repeat(499) + "🎉🎉")).toBe("x".repeat(499) + "🎉")
    expect(fitNote("short")).toBe("short")
  })

  it("turns the counter amber from 450", () => {
    expect(counterTone(449)).toBe("text-faint-foreground")
    expect(counterTone(450)).toContain("text-warning")
    expect(counterTone(500)).toContain("text-warning")
  })

  it("tells the three save failures apart", () => {
    expect(failureFor(409)).toBe("closed")
    expect(failureFor(429)).toBe("limited")
    for (const s of [null, 500, 503, 400, 403]) expect(failureFor(s)).toBe("failed")
  })
})

describe("the clock's words", () => {
  it("says a moment on the event's clock with no zone, the minutes only when there are some", () => {
    expect(lobbyMoment(new Date("2026-11-08T11:00:00Z"), "Asia/Kolkata")).toBe("Sun 8 Nov, 4:30 PM")
    expect(lobbyMoment(new Date("2026-11-09T18:30:00Z"), "Asia/Kolkata")).toBe("Tue 10 Nov, 12 AM")
    expect(lobbyMoment(new Date("2026-11-13T22:30:00Z"), "America/Toronto")).toBe("Fri 13 Nov, 5:30 PM")
  })

  it("says when the note changed as the mockup does", () => {
    const now = "2026-11-06T10:00:00.000Z"
    expect(updatedAgo("2026-11-06T09:59:40.000Z", now)).toBe("just now")
    expect(updatedAgo("2026-11-06T09:35:00.000Z", now)).toBe("25 min ago")
    expect(updatedAgo("2026-11-06T07:00:00.000Z", now)).toBe("3 h ago")
    expect(updatedAgo("2026-11-03T10:00:00.000Z", now)).toBe("3 d ago")
  })
})
