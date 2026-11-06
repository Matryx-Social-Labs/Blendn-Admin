jest.mock("@/lib/db", () => ({ db: {} }))

import { lobbyHidesTickets, lobbyState, OFFER_ANSWERS, SUB_KINDS, subKindFits, subKindsFor } from "@/lib/board"
import { chatClosesAt, DOORS_LEAD_MINUTES, doorsAt } from "@/lib/chat-window"
import { photoVerdict } from "@/lib/lobby-photo"
import { CHECK_IN_LEAD_MINUTES } from "@/lib/occurrences"

/*
 * The Lobby's one lifecycle and its plain types (SCRUM-1026), as pure rules.
 * The routes are driven against real rows in __tests__/integration/lobby*.itest.ts.
 */
const START = new Date("2030-11-08T18:00:00Z")
const END = new Date("2030-11-08T23:00:00Z")
const event = { start_time: START, end_time: END, kind: "event" as const }
const ms = (minutes: number) => minutes * 60_000

describe("the Lobby's lifecycle", () => {
  it("is open until doors, read-only from doors, closed a day after the end", () => {
    const doors = doorsAt(event)
    expect(doors).toEqual(new Date(START.getTime() - ms(90)))
    expect(lobbyState(event, new Date(doors.getTime() - 1))).toBe("open")
    expect(lobbyState(event, doors)).toBe("read_only")
    expect(lobbyState(event, new Date(END.getTime() + 24 * 3_600_000 - 1))).toBe("read_only")
    expect(lobbyState(event, new Date(END.getTime() + 24 * 3_600_000))).toBe("closed")
  })

  it("closes on the room's own clock, so the two cannot drift", () => {
    expect(lobbyState(event, chatClosesAt(event))).toBe("closed")
    // A venue day's room closes at its reset: so does its Lobby.
    const day = { ...event, kind: "venue_day" as const }
    expect(lobbyState(day, END)).toBe("closed")
  })

  it("has doors where check-in opens", () => {
    expect(CHECK_IN_LEAD_MINUTES).toBe(DOORS_LEAD_MINUTES)
  })
})

describe("plain types", () => {
  it("fits an offer to a ride, spots or a spare ticket, a search to a ride, a buddy or a ticket, and a chat post to nothing", () => {
    expect(SUB_KINDS).toEqual({ offer: ["ride", "spots", "ticket"], seeking: ["ride", "buddy", "ticket"], chat: [] })
    expect(subKindFits("offer", "spots")).toBe(true)
    expect(subKindFits("seeking", "spots")).toBe(false)
    expect(subKindFits("offer", "buddy")).toBe(false)
    expect(subKindFits("chat", "ride")).toBe(false)
  })

  it("hides both ticket kinds on an event whose tickets are sold here, and only while ticketing is on", () => {
    expect(lobbyHidesTickets({ ticketing_mode: "native" }, true)).toBe(true)
    expect(lobbyHidesTickets({ ticketing_mode: "native" }, false)).toBe(false)
    expect(lobbyHidesTickets({ ticketing_mode: "external" }, true)).toBe(false)
    expect(subKindsFor(true)).toEqual({ offer: ["ride", "spots"], seeking: ["ride", "buddy"], chat: [] })
    expect(subKindsFor(false)).toEqual({ offer: ["ride", "spots", "ticket"], seeking: ["ride", "buddy", "ticket"], chat: [] })
  })

  it("matches an offer to what people look for", () => {
    expect(OFFER_ANSWERS).toEqual({ ride: "ride", spots: "buddy", ticket: "ticket" })
  })
})

describe("a photo's verdict", () => {
  const result = (action: "allow" | "flag" | "hide") => ({ action, source: "openai_image" as const, categories: {}, confidence: 0.5 })
  it("approves only a clean look; a maybe is a no; no look leaves it pending", () => {
    expect(photoVerdict({ checked: true, result: null })).toBe("approved")
    expect(photoVerdict({ checked: true, result: result("allow") })).toBe("approved")
    expect(photoVerdict({ checked: true, result: result("flag") })).toBe("rejected")
    expect(photoVerdict({ checked: true, result: result("hide") })).toBe("rejected")
    expect(photoVerdict({ checked: false, reason: "timeout" })).toBeNull()
    expect(photoVerdict({ checked: false, reason: "no_key" })).toBeNull()
  })
})
