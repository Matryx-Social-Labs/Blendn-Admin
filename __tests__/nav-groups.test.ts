import { NAV_GROUPS, dashboardNav, groupedNavFor, visibleNavFor } from "@/lib/dashboard-nav"

/**
 * Every destination sits under a heading, and no heading sits over nothing.
 *
 * An admin sees eighteen destinations. They were one flat list under a single
 * label — the role name — so the nav had no structure to scan, on a screen
 * whose own design system says "hierarchy comes from type, not boxes".
 *
 * Two failure modes, and they pull in opposite directions:
 *
 *   - a new item with no `group` falls silently to the top, above the first
 *     heading, which is where `Overview` lives and nothing else should
 *   - a static group list renders headings for roles that have no items under
 *     them. A sponsor sees three destinations; four empty headings above them
 *     would be worse than the flat list this replaces
 *
 * Both are asserted, because fixing either one alone produces the other.
 */
describe("the sidebar groups its destinations", () => {
  it("gives every item but Overview a group", () => {
    /*
     * `Overview` is deliberately ungrouped: it is the landing page, and a
     * heading over one item is a heading that says nothing. Anything else
     * arriving without a group is an omission, not a decision.
     */
    const ungrouped = dashboardNav.filter((i) => !i.group).map((i) => i.title)
    expect(ungrouped).toEqual(["Overview"])
  })

  it("uses only groups that have a heading", () => {
    const known = new Set(NAV_GROUPS.map((g) => g.key))
    const orphans = dashboardNav.filter((i) => i.group && !known.has(i.group)).map((i) => i.title)
    expect(orphans).toEqual([])
  })

  it("renders no heading with nothing under it, for any role", () => {
    // The failure a static group list produces once the role gate has run.
    for (const role of ["app_admin", "organizer", "venue_owner", "sponsor"]) {
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
    for (const role of ["app_admin", "organizer", "venue_owner", "sponsor"]) {
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
