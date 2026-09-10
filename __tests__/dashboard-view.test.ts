import { readFileSync } from "fs"
import { join } from "path"
import { barWidth } from "@/lib/dashboard-view"
import { mayReachRoute, visibleNavFor } from "@/lib/dashboard-nav"
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
      // "Venue claims" became "Claims" when #284 merged the event and venue
      // queues behind one entry; the sponsor entries below are #264's and are
      // unrelated to it. Only the merged tree sees both halves.
      "Claims",
      "Brands",
      "Creative review",
      "Charges",
      "Applications",
      "Organisations",
      "Categories",
      "Amenities",
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

  it("badges only the queues a person works through", () => {
    /*
     * A badge is a claim that something is waiting. Each of these is worked
     * through by a person, so each counts down to zero; anything else with a
     * badge would be decoration that never clears.
     *
     * Claims joined the list when the venue queue and the new event queue
     * became one nav entry. The count covers both, for the same reason the
     * moderation badge covers flags AND reports: one entry with a count for
     * half of it leaves somebody waiting with no number anywhere in the chrome.
     *
     * Creative review joined last, and its absence was the same defect at a
     * smaller scale: it sat in "Needs a decision" with no count anywhere, so a
     * sponsor waiting on a human was invisible from every screen but its own.
     * Every entry in this group now carries one — which is the invariant worth
     * holding, and `attention-queues.test.ts` holds the other half of it.
     */
    const badged = visibleNavFor("app_admin").filter((item) => item.badgeKey)
    expect(badged.map((item) => item.title)).toEqual([
      "Moderation",
      "Claims",
      "Creative review",
      "Applications",
    ])
    expect(badged.map((item) => item.badgeKey)).toEqual([
      "pendingFlags",
      "pendingClaims",
      "pendingCreative",
      "pendingApplications",
    ])

    // Every "needs a decision" entry has one. That is the rule; the list above
    // is just today's instance of it.
    const decisions = visibleNavFor("app_admin").filter((item) => item.group === "decisions")
    expect(decisions.filter((item) => !item.badgeKey)).toEqual([])
  })

  it("keeps Claims lit across both of its queues", () => {
    // Otherwise the sidebar un-highlights itself the moment somebody switches
    // tab, which reads as having navigated away from the section they are in.
    const claims = visibleNavFor("app_admin").find((i) => i.title === "Claims")!
    expect(claims.isActive!("/dashboard/claims")).toBe(true)
    expect(claims.isActive!("/dashboard/claims/venues")).toBe(true)
    expect(claims.isActive!("/dashboard/events")).toBe(false)
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

describe("mayReachRoute", () => {
  /*
   * The gate and the menu come from one list now.
   *
   * `/dashboard/brand` and `/dashboard/placements` gated on
   * `canAccessDashboard` — true for all four dashboard roles — while the nav
   * declared them sponsor-only. So the link was hidden from the people who
   * should use it and the URL worked for everybody else, which is the worst
   * combination of the two mistakes.
   */
  it("lets a sponsor reach the sponsor screens", () => {
    expect(mayReachRoute("sponsor", "/dashboard/brand")).toBe(true)
    expect(mayReachRoute("sponsor", "/dashboard/placements")).toBe(true)
  })

  it("keeps everybody else out of them", () => {
    for (const role of ["organizer", "venue_owner", "app_admin"]) {
      expect(mayReachRoute(role, "/dashboard/brand")).toBe(false)
      expect(mayReachRoute(role, "/dashboard/placements")).toBe(false)
    }
  })

  it("agrees with the menu for every role and every item", () => {
    /*
     * The property that matters, rather than a handful of cases: whatever the
     * nav shows a role is exactly what that role may reach. Drift between the
     * two is the defect, so the test is the equivalence itself.
     */
    for (const role of ["app_admin", "organizer", "venue_owner", "sponsor"]) {
      const shown = new Set(visibleNavFor(role).map((i) => i.url))
      for (const item of visibleNavFor("app_admin").concat(visibleNavFor("sponsor"))) {
        expect(mayReachRoute(role, item.url)).toBe(shown.has(item.url))
      }
    }
  })

  it("fails closed on an unknown role and an undeclared route", () => {
    expect(mayReachRoute(undefined, "/dashboard/brand")).toBe(false)
    expect(mayReachRoute("attendee", "/dashboard/brand")).toBe(false)
    // A page nobody declared is a page nobody reasoned about.
    expect(mayReachRoute("app_admin", "/dashboard/not-a-real-page")).toBe(false)
  })

  it("still allows the unlisted routes, which carry their own gates", () => {
    expect(mayReachRoute("organizer", "/dashboard/settings")).toBe(true)
  })
})

describe("every dashboard role has an overview", () => {
  /*
   * `getDashboardOverview` branched on `app_admin` and `venue_owner` and fell
   * through to the organiser build for everything else — so a sponsor got an
   * organiser dashboard scoped to `organizer_id = <their own user id>`, a
   * column that is never theirs. Permanently all zeros, and it read as a quiet
   * month rather than as the wrong question.
   *
   * The hole was in the type union too: three members for four roles, with
   * nothing making the fourth a type error.
   */
  it("has a discriminant for each role the shell admits", () => {
    const src = readFileSync(join(__dirname, "..", "lib", "dashboard-types.ts"), "utf8")
    for (const role of ["app_admin", "organizer", "venue_owner", "sponsor"]) {
      expect(src).toContain(`role: "${role}"`)
    }
  })

  it("routes the sponsor to its own builder", () => {
    const src = readFileSync(join(__dirname, "..", "app", "dashboard", "actions.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")
    expect(src).toMatch(/role === "sponsor"\s*\)\s*return await buildSponsorOverview\(\)/)
  })
})
