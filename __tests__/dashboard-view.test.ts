import { funnelBarWidth } from "@/lib/dashboard-view"
import { visibleNavFor } from "@/lib/dashboard-nav"

describe("funnelBarWidth", () => {
  it("draws nothing for a stage nobody reached", () => {
    // The bug this replaces: `Math.max(10, ...)` gave an empty stage a bar a
    // tenth as wide as the best one, so a funnel that dropped to zero still
    // looked like it converted.
    expect(funnelBarWidth(0, 500)).toBe(0)
  })

  it("is proportional to the largest stage", () => {
    expect(funnelBarWidth(250, 500)).toBe(50)
    expect(funnelBarWidth(500, 500)).toBe(100)
  })

  it("keeps a tiny non-zero stage visible", () => {
    expect(funnelBarWidth(1, 50_000)).toBe(2)
  })

  it("never exceeds full width", () => {
    expect(funnelBarWidth(900, 500)).toBe(100)
  })

  it("returns zero rather than dividing by zero on an empty funnel", () => {
    expect(funnelBarWidth(0, 0)).toBe(0)
    expect(funnelBarWidth(5, 0)).toBe(0)
  })
})

describe("visibleNavFor", () => {
  const titles = (role: string | undefined) =>
    visibleNavFor(role).map((item) => item.title)

  it("gives app_admin every section", () => {
    expect(titles("app_admin")).toEqual([
      "Overview",
      "Events",
      "Chatrooms",
      "Users",
      "Organisers",
      "Venue Owners",
    ])
  })

  it("keeps platform administration away from hosts", () => {
    for (const role of ["organizer", "venue_owner"]) {
      expect(titles(role)).not.toContain("Users")
      expect(titles(role)).not.toContain("Organisers")
      expect(titles(role)).not.toContain("Venue Owners")
    }
  })

  it("shows Chatrooms to venue owners", () => {
    // lib/rbac.ts `canModerateChat` grants venue_owner moderation over its own
    // events and the messaging page gates on `canManageEvent`, which agrees.
    // The nav was the only thing saying no.
    expect(titles("venue_owner")).toContain("Chatrooms")
  })

  it("fails closed for an attendee or a missing role", () => {
    expect(titles("attendee")).toEqual([])
    expect(titles(undefined)).toEqual([])
    expect(titles("not-a-role")).toEqual([])
  })
})

describe("nav active matching", () => {
  const item = (title: string) =>
    visibleNavFor("app_admin").find((entry) => entry.title === title)!

  it("does not light up Events while a messaging page is open", () => {
    expect(item("Events").isActive!("/dashboard/events/abc/messaging")).toBe(false)
    expect(item("Chatrooms").isActive!("/dashboard/events/abc/messaging")).toBe(true)
  })

  it("lights up Events for the list, the editor, and the new form", () => {
    expect(item("Events").isActive!("/dashboard/events")).toBe(true)
    expect(item("Events").isActive!("/dashboard/events/new")).toBe(true)
    expect(item("Events").isActive!("/dashboard/events/abc")).toBe(true)
  })
})
