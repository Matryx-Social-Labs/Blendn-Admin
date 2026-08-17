import { barWidth } from "@/lib/dashboard-view"
import { visibleNavFor } from "@/lib/dashboard-nav"
import { formatAge, formatPct, formatSince } from "@/lib/dashboard-format"

describe("barWidth", () => {
  it("draws nothing for a stage nobody reached", () => {
    // The bug this replaces: `Math.max(10, …)` gave an empty funnel stage a bar
    // a tenth as wide as the best one, so a funnel that dropped to zero still
    // looked like it converted.
    expect(barWidth(0, 500)).toBe(0)
  })

  it("is proportional to the largest value", () => {
    expect(barWidth(250, 500)).toBe(50)
    expect(barWidth(500, 500)).toBe(100)
  })

  it("keeps a tiny non-zero value visible", () => {
    expect(barWidth(1, 50_000)).toBe(2)
    expect(barWidth(1, 50_000, 3)).toBe(3)
  })

  it("never exceeds full width", () => {
    expect(barWidth(900, 500)).toBe(100)
  })

  it("returns zero rather than dividing by zero", () => {
    expect(barWidth(0, 0)).toBe(0)
    expect(barWidth(5, 0)).toBe(0)
  })
})

describe("formatPct", () => {
  it("renders an em dash for null, not 0%", () => {
    // Load-bearing across the dashboard: an event with no stated capacity has
    // no fill percentage, which is not the same as being empty.
    expect(formatPct(null)).toBe("—")
    expect(formatPct(0)).toBe("0%")
  })

  it("rounds to whole percent", () => {
    expect(formatPct(72.4)).toBe("72%")
  })
})

describe("formatAge", () => {
  it("scales the unit with the age", () => {
    expect(formatAge(0.5)).toBe("just now")
    expect(formatAge(9)).toBe("9h")
    expect(formatAge(26)).toBe("1d")
    expect(formatAge(null)).toBe("—")
  })
})

describe("formatSince", () => {
  it("says never rather than inventing a date", () => {
    expect(formatSince(null)).toBe("never")
  })

  it("uses relative words near today", () => {
    const now = Date.now()
    expect(formatSince(new Date(now).toISOString())).toBe("today")
    expect(formatSince(new Date(now - 26 * 60 * 60 * 1000).toISOString())).toBe("yesterday")
    expect(formatSince(new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString())).toBe("5d ago")
  })
})

describe("visibleNavFor", () => {
  const titles = (role: string | undefined) => visibleNavFor(role).map((item) => item.title)

  it("gives app_admin the platform sections including Moderation", () => {
    expect(titles("app_admin")).toEqual([
      "Overview",
      "Moderation",
      "Events",
      "Chatrooms",
      "Users",
      "Organisers",
      "Venues",
      "Leads",
      "Venue claims",
      "Brands",
      "Brand claims",
      "Applications",
      "Organisations",
      "Categories",
      "Reports",
      "Audit log",
    ])
  })

  it("gives each host role its own screens, not a shared list", () => {
    // The whole point of the redesign's IA: venue_owner used to get the
    // organiser's nav, which is why the role's actual questions had no home.
    expect(titles("organizer")).toEqual([
      "Overview",
      "Events",
      "Attendees",
      "Chatrooms",
      "My organisation",
      "Reports",
      "Audit log",
    ])
    expect(titles("venue_owner")).toEqual([
      "Overview",
      "Events",
      "My venues",
      "Chatrooms",
      "My organisation",
      "Reports",
      "Audit log",
    ])
  })

  it("gives a sponsor their own two screens and nothing else", () => {
    /*
     * A sponsor is not a small organiser. They see where their brand appears
     * and what is waiting on them — not attendees, not moderation, not
     * Chatrooms, not other people's events.
     *
     * "My organisation" is included because a sponsor's team IS an
     * organisation: they invite colleagues through the same
     * `organisation_invites` flow as every other company on the platform.
     */
    expect(titles("sponsor")).toEqual([
      "Overview",
      "Placements",
      "Brand",
      "My organisation",
    ])
  })

  it("shows nothing to an attendee or an unknown role", () => {
    // Fails closed. `visibleNavFor` returning [] for a role it does not know is
    // what makes adding a role to the enum a visible change rather than a
    // silent one — the sidebar is empty until somebody wires it.
    expect(titles("attendee")).toEqual([])
    expect(titles("something_new")).toEqual([])
    expect(titles(undefined)).toEqual([])
  })

  it("keeps the two organisation screens apart", () => {
    // A host manages their own company; an admin manages every company. Giving
    // an admin the host screen would record support actions as though the org's
    // own owner took them.
    expect(titles("app_admin")).not.toContain("My organisation")
    for (const role of ["organizer", "venue_owner"]) {
      expect(titles(role)).not.toContain("Organisations")
      expect(titles(role)).not.toContain("Applications")
    }
  })

  it("keeps platform administration away from hosts", () => {
    for (const role of ["organizer", "venue_owner"]) {
      expect(titles(role)).not.toContain("Users")
      expect(titles(role)).not.toContain("Organisers")
      expect(titles(role)).not.toContain("Venues")
      expect(titles(role)).not.toContain("Moderation")
    }
  })

  it("shows Chatrooms to venue owners", () => {
    // `eventPermissions` grants venue owners the operational bucket for events
    // at a venue they own, and every screen behind this item gates on that same
    // resolver — so the nav and the pages cannot disagree.
    expect(titles("venue_owner")).toContain("Chatrooms")
  })

  it("fails closed for an attendee or a missing role", () => {
    expect(titles("attendee")).toEqual([])
    expect(titles(undefined)).toEqual([])
    expect(titles("not-a-role")).toEqual([])
  })

  it("badges only the two admin queues", () => {
    // A badge is a claim that something is waiting. Both of these are worked
    // through by a person, so both count down to zero; anything else with a
    // badge would be decoration that never clears.
    const badged = visibleNavFor("app_admin").filter((item) => item.badgeKey)
    expect(badged.map((item) => item.title)).toEqual(["Moderation", "Applications"])
    expect(badged.map((item) => item.badgeKey)).toEqual(["pendingFlags", "pendingApplications"])
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
