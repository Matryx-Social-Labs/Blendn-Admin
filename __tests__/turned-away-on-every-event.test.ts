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
 * published event (upcoming too since SCRUM-494, for "Before doors"), and the
 * panel to the Overview between Attendance and Connections, with the link to
 * the editor only when the fence is at fault.
 */
const root = join(__dirname, "..")
const page = readFileSync(join(root, "app", "dashboard", "events", "[id]", "page.tsx"), "utf8")
const overview = readFileSync(join(root, "app", "dashboard", "events", "[id]", "overview.tsx"), "utf8")
const panel = readFileSync(join(root, "components", "dashboard", "turned-away-panel.tsx"), "utf8")

describe("the event page", () => {
  it("loads the organiser's refusals for every published event, not only when curated", () => {
    const load = page.indexOf("eventRefusals(event.id)")
    expect(load).toBeGreaterThan(-1)
    // Alongside attendance, not in the curated branch.
    const batch = page.lastIndexOf("const [attendance, connections, turnedAway]", load)
    expect(batch).toBeGreaterThan(-1)
    expect(page.slice(batch, load)).toContain("getEventAttendance(event.id)")
    expect(page.slice(batch, load)).not.toMatch(/curated_open/)
    // A venue's view passes it only above the floor (PR #601): venues see
    // aggregates, never people, and "1 turned away" is about a person.
    expect(page).toMatch(/turnedAway=\{turnedAway && venueMaySee\(turnedAway\.people\) \? turnedAway : null\}/)
  })

  it("loads them before the doors too, where a too_early refusal is a wrong start time (SCRUM-494)", () => {
    // Gated on draft only: an upcoming event is exactly when "Before doors"
    // refusals happen and the start time can still be corrected. Attendance
    // and connections stay gated on the event having run.
    expect(page).toMatch(/overview\.state !== "draft"\s*\?\s*eventRefusals\(event\.id\)/)
    // The venue's view never loads attendance at all (PR #601).
    expect(page).toMatch(/hasRun && !venueView \? getEventAttendance\(event\.id\)/)
    // Curation keeps its own attempts-ranked read before the doors.
    expect(page).toMatch(/: hasRun && turnedAway\s*\?/)
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
