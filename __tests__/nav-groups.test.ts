import {
  HOST_NAV_GROUPS,
  NAV_GROUPS,
  dashboardNav,
  groupedNavFor,
  visibleNavFor,
} from "@/lib/dashboard-nav"

/**
 * Every destination sits under a heading, and no heading sits over nothing.
 *
 * Two vocabularies. An admin sees eighteen destinations under six headings
 * ("Needs a decision" … "Record"). A host sees at most seven, in the design
 * kit's three blocks: the work itself with no heading, then Community, then
 * Organisation.
 *
 * Two failure modes, and they pull in opposite directions:
 *
 *   - a new admin item with no `group` falls silently to the top, above the
 *     first heading, which is where `Overview` lives and nothing else should
 *   - a static group list renders headings for roles that have no items under
 *     them. A sponsor sees four destinations; empty headings above them would
 *     be worse than a flat list
 *
 * Both are asserted, because fixing either one alone produces the other.
 */
const HOSTS = ["organizer", "venue_owner", "sponsor"]
const titlesByGroup = (role: string) =>
  groupedNavFor(role).map((g) => [g.label, g.items.map((i) => i.title)])

describe("the sidebar groups its destinations", () => {
  it("gives every item an admin sees, but Overview, an admin group", () => {
    /*
     * `Overview` is deliberately ungrouped: it is the landing page, and a
     * heading over one item is a heading that says nothing. Anything else
     * arriving without a group is an omission, not a decision.
     */
    const ungrouped = visibleNavFor("app_admin")
      .filter((i) => !i.group)
      .map((i) => i.title)
    expect(ungrouped).toEqual(["Overview"])
  })

  it("puts no admin group on an item no admin sees", () => {
    // A heading nobody renders is data that drifts: the host items that had
    // one were rendering under People and Setup, words for the platform.
    const stray = dashboardNav
      .filter((i) => i.group && !i.allowedRoles.includes("app_admin"))
      .map((i) => i.title)
    expect(stray).toEqual([])
  })

  it("uses only groups that have a heading", () => {
    const admin = new Set(NAV_GROUPS.map((g) => g.key))
    const host = new Set(HOST_NAV_GROUPS.map((g) => g.key))
    const orphans = dashboardNav
      .filter((i) => (i.group && !admin.has(i.group)) || (i.hostGroup && !host.has(i.hostGroup)))
      .map((i) => i.title)
    expect(orphans).toEqual([])
  })

  it("lays the organiser's nav out as the kit does", () => {
    // Analytics and Plan joined with their pages (step 16), because a nav
    // item to nothing is a 404 with a label.
    expect(titlesByGroup("organizer")).toEqual([
      [null, ["Overview", "Events", "Analytics"]],
      ["Community", ["Attendees", "Chatrooms"]],
      ["Organisation", ["Team", "Reports", "Audit log", "Plan"]],
    ])
  })

  it("gives venue owners and sponsors the same three blocks", () => {
    expect(titlesByGroup("venue_owner")).toEqual([
      [null, ["Overview", "Events", "My venues"]],
      ["Community", ["Chatrooms"]],
      ["Organisation", ["Team", "Reports", "Audit log"]],
    ])
    expect(titlesByGroup("sponsor")).toEqual([
      [null, ["Overview", "Placements"]],
      ["Organisation", ["Brand", "Team"]],
    ])
  })

  it("keeps the admin's six headings", () => {
    expect(groupedNavFor("app_admin").map((g) => g.label)).toEqual([
      null,
      ...NAV_GROUPS.map((g) => g.label),
    ])
  })

  it("renders no heading with nothing under it, for any role", () => {
    // The failure a static group list produces once the role gate has run.
    for (const role of ["app_admin", ...HOSTS]) {
      const empty = groupedNavFor(role).filter((g) => g.items.length === 0)
      expect({ role, empty }).toEqual({ role, empty: [] })
    }
  })

  it("loses no destination to the grouping", () => {
    /*
     * The grouped view is a re-ordering, never a filter. An item whose group
     * key was mistyped would otherwise vanish from the sidebar entirely while
     * every other assertion here stayed green.
     */
    for (const role of ["app_admin", ...HOSTS]) {
      const flat = visibleNavFor(role).map((i) => i.title).sort()
      const grouped = groupedNavFor(role)
        .flatMap((g) => g.items.map((i) => i.title))
        .sort()
      expect({ role, grouped }).toEqual({ role, grouped: flat })
    }
  })

  it("puts every badge under the same heading", () => {
    /*
     * Badges mark the only items with an SLA, and "Needs a decision" is the
     * heading that says so. One escaping into Supply or Setup would put a
     * counter somewhere nobody is looking for work.
     */
    const badged = dashboardNav.filter((i) => i.badgeKey)
    expect(badged.length).toBeGreaterThan(2)
    expect([...new Set(badged.map((i) => i.group))]).toEqual(["decisions"])
  })

  it("leads with the group that has an SLA", () => {
    expect(NAV_GROUPS[0].key).toBe("decisions")
    expect(NAV_GROUPS[NAV_GROUPS.length - 1].key).toBe("record")
  })
})
