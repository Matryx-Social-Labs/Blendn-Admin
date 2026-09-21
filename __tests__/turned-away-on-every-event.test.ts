import { readFileSync } from "fs"
import { join } from "path"

import { shortfall } from "@/components/dashboard/turned-away-panel"

/*
 * The organiser sees their own door (SCRUM-196).
 *
 * Driven on staging: two people were refused out of range at good fixes, the
 * platform overview counted them, and the event page said nothing — because
 * the only per-event reader was gated on curated events "so an organiser's
 * own event pays nothing". This pins the new reader to the event page for any
 * event that has run, and the panel to the Overview between Attendance and
 * Connections, with the link to the editor only when the fence is at fault.
 */
const root = join(__dirname, "..")
const page = readFileSync(join(root, "app", "dashboard", "events", "[id]", "page.tsx"), "utf8")
const overview = readFileSync(join(root, "app", "dashboard", "events", "[id]", "overview.tsx"), "utf8")
const panel = readFileSync(join(root, "components", "dashboard", "turned-away-panel.tsx"), "utf8")

describe("the event page", () => {
  it("loads the organiser's refusals whenever the event has run, not only when curated", () => {
    const load = page.indexOf("eventRefusals(event.id)")
    expect(load).toBeGreaterThan(-1)
    // Inside the live/over branch, alongside attendance — not the curated one.
    const branch = page.lastIndexOf('overview.state === "live" || overview.state === "over"', load)
    expect(branch).toBeGreaterThan(-1)
    expect(page.slice(branch, load)).toContain("getEventAttendance(event.id)")
    expect(page.slice(branch, load)).not.toMatch(/curated_open/)
    expect(page).toMatch(/turnedAway=\{turnedAway\}/)
  })
})

describe("the Overview", () => {
  it("places Turned away between Attendance and Connections, hidden at zero", () => {
    const attendance = overview.indexOf("<AttendancePanel")
    const turned = overview.indexOf("<TurnedAwayPanel")
    const connections = overview.indexOf("<ConnectionsPanel")
    expect(attendance).toBeGreaterThan(-1)
    expect(turned).toBeGreaterThan(attendance)
    expect(connections).toBeGreaterThan(turned)
    expect(overview.slice(turned - 200, turned)).toContain("turnedAway.people > 0")
  })
})

describe("the panel", () => {
  it("offers the editor only when the fence is at fault and the reader may edit", () => {
    expect(panel).toMatch(/const fence = verdict === "fence" \|\| verdict === "mixed"/)
    expect(panel).toMatch(/\{fence && canEdit \? \(/)
    expect(panel).toContain("/edit#step-where")
    // The destructive colour is spent on the figure only when it is the fence.
    expect(panel).toMatch(/verdict === "fence" && "text-destructive"/)
  })
})

describe("the shortfall the organiser reads", () => {
  it("is metres when you could walk it and kilometres when you could not", () => {
    expect(shortfall(40)).toBe("~40 m out")
    expect(shortfall(999)).toBe("~999 m out")
    expect(shortfall(1000)).toBe("~1.0 km out")
    expect(shortfall(845253)).toBe("~845 km out")
    // One decimal under 10 km, none above — 9999 m rounds to the boundary.
    expect(shortfall(9999)).toBe("~10.0 km out")
    expect(shortfall(10000)).toBe("~10 km out")
  })
})
