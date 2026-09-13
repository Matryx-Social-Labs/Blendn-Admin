import {
  IconBuilding,
  IconBuildingStore,
  IconCategory,
  IconDashboard,
  IconFileSpreadsheet,
  IconFlag,
  IconHistory,
  IconFileCheck,
  IconInbox,
  IconListDetails,
  IconMessage2,
  IconMicrophone2,
  IconReceipt,
  IconUsers,
} from "@tabler/icons-react"

import type { DashboardRole } from "@/lib/dashboard-types"

/**
 * What a destination is *for*, which is what a heading over it should say.
 *
 * An admin sees eighteen destinations. Flat, under one label, that is a list
 * you read rather than scan — and the design system's own rule is that
 * "hierarchy comes from type, not boxes", which the nav had none of either way.
 *
 * Grouped by the question each item answers, not by table name:
 *
 *   decisions  something is waiting on a human. Every badge lives here.
 *   supply     what is on the platform to go to, and who put it there
 *   people     who is on it
 *   commercial money
 *   setup      vocabulary and settings that change rarely
 *   record     what already happened
 *
 * `Overview` has no group on purpose: it is the landing page, and a heading
 * over a single item is a heading that says nothing.
 */
export type NavGroup = "decisions" | "supply" | "people" | "commercial" | "setup" | "record"

/**
 * Render order and headings.
 *
 * Decisions first because they are the only ones with an SLA — the moderation
 * queue is ordered oldest-first for the same reason. Record last because it is
 * the only group nobody opens unless something has already gone wrong.
 */
export const NAV_GROUPS: { key: NavGroup; label: string }[] = [
  { key: "decisions", label: "Needs a decision" },
  { key: "supply", label: "Supply" },
  { key: "people", label: "People" },
  { key: "commercial", label: "Commercial" },
  { key: "setup", label: "Setup" },
  { key: "record", label: "Record" },
]

export interface DashboardNavItem {
  title: string
  description: string
  url: string
  icon: typeof IconDashboard
  allowedRoles: DashboardRole[]
  /** Which heading it sits under. Absent means "above the first heading". */
  group?: NavGroup
  /** Renders a count next to the item. */
  badgeKey?: "pendingFlags" | "pendingApplications" | "pendingClaims" | "pendingCreative"
  isActive?: (pathname: string) => boolean
}

/**
 * Navigation, per role.
 *
 * Lives here rather than inside the sidebar component so the role gate is
 * testable without mounting something that wants a NextAuth session — it had
 * drifted from `lib/rbac.ts` once already.
 *
 * The three roles get genuinely different navigation, which is the point. The
 * old version gave venue owners the organiser's nav; a venue owner has no use
 * for an "Attendees" list spanning other people's events, and an organiser has
 * no business in the platform-wide user table.
 */
export const dashboardNav: DashboardNavItem[] = [
  {
    title: "Overview",
    description: "Platform health: what needs attention, growth vs vanity, and supply.",
    url: "/dashboard",
    icon: IconDashboard,
    allowedRoles: ["app_admin", "organizer", "venue_owner", "sponsor"],
  },
  {
    // Platform-wide, and new: moderation was previously reachable only by
    // opening one event's messaging page at a time, which is unusable as a
    // queue when the SLA is how long a flag has been waiting.
    title: "Moderation",
    description: "Flags and reports across the platform, oldest first.",
    url: "/dashboard/moderation",
    icon: IconFlag,
    allowedRoles: ["app_admin"],
    group: "decisions",
    badgeKey: "pendingFlags",
  },
  {
    title: "Events",
    description: "Every event on the platform — search, filter, and drill in.",
    url: "/dashboard/events",
    icon: IconListDetails,
    allowedRoles: ["app_admin", "organizer", "venue_owner"],
    group: "supply",
    isActive: (pathname) =>
      pathname === "/dashboard/events" ||
      pathname === "/dashboard/events/new" ||
      (pathname.startsWith("/dashboard/events/") && !pathname.endsWith("/messaging")),
  },
  {
    title: "Attendees",
    description: "Who comes back, and who RSVPs but doesn't show.",
    url: "/dashboard/attendees",
    icon: IconUsers,
    allowedRoles: ["organizer"],
    group: "people",
  },
  {
    title: "My venues",
    description: "Utilisation, ratings and bookings — one section per venue.",
    url: "/dashboard/venues",
    icon: IconBuildingStore,
    allowedRoles: ["venue_owner"],
    group: "supply",
  },
  {
    // Sponsor-side. A sponsor sees their own placements and campaigns and
    // nothing else — not attendees, not moderation, not other people's events.
    title: "Placements",
    description: "Where your brand appears, and what is waiting on you.",
    url: "/dashboard/placements",
    icon: IconMicrophone2,
    allowedRoles: ["sponsor"],
    group: "commercial",
  },
  {
    title: "Brand",
    description: "Your name, logo and website, as attendees see them.",
    url: "/dashboard/brand",
    icon: IconBuildingStore,
    allowedRoles: ["sponsor"],
    group: "commercial",
  },
  {
    title: "Chatrooms",
    description: "Every room whose chat is open — live events and post-event feedback windows.",
    url: "/dashboard/chatrooms",
    icon: IconMessage2,
    // venue_owner belongs here: `eventPermissions` grants them the operational
    // bucket for events at a venue they own, and for events they run
    // themselves. Every screen behind this item gates on the same resolver, so
    // the nav and the pages cannot disagree the way they did before.
    allowedRoles: ["app_admin", "organizer", "venue_owner"],
    group: "people",
    isActive: (pathname) =>
      pathname === "/dashboard/chatrooms" || pathname.endsWith("/messaging"),
  },
  {
    title: "Users",
    description: "Accounts, onboarding, and reachability.",
    url: "/dashboard/users",
    icon: IconUsers,
    allowedRoles: ["app_admin"],
    group: "people",
  },
  {
    title: "Organisers",
    description: "The supply side: who publishes, and how concentrated it is.",
    url: "/dashboard/organisers",
    icon: IconMicrophone2,
    allowedRoles: ["app_admin"],
    group: "supply",
  },
  {
    title: "Venues",
    description: "Every venue record — who owns each, which are unclaimed, and open disputes.",
    /*
     * Was `/dashboard/venue-owners`, which is a list of venue-owner *user
     * accounts* — so this entry described venue records and delivered people.
     * The records screen now exists; the accounts screen stays reachable and
     * is listed in `unlistedRoutes`, since "who owns this venue" is a question
     * you arrive at from a venue rather than from the sidebar.
     */
    url: "/dashboard/venues",
    icon: IconBuildingStore,
    allowedRoles: ["app_admin"],
    group: "supply",
  },
  {
    title: "Leads",
    description: "Demo requests from the organiser landing page. Oldest untouched first.",
    url: "/dashboard/leads",
    icon: IconInbox,
    allowedRoles: ["app_admin"],
    group: "commercial",
  },
  {
    /*
     * One entry, two queues.
     *
     * Was "Venue claims". Claims on an event and claims on a venue are separate
     * tables answering separate questions, and one job done by one person in one
     * sitting -- so a second nav entry would have been a second place to
     * remember to look, which is how a queue ends up unread.
     *
     * `isActive` covers both, or the sidebar would un-highlight itself the
     * moment somebody switched tab.
     */
    title: "Claims",
    description:
      "Ownership requests for events, venues and brands. Approving one hands over an attendee list, a building, or a brand's reporting.",
    url: "/dashboard/claims",
    icon: IconFileCheck,
    allowedRoles: ["app_admin"],
    group: "decisions",
    badgeKey: "pendingClaims",
    isActive: (pathname) => pathname.startsWith("/dashboard/claims"),
  },
  {
    title: "Brands",
    description: "Every brand — who owns each, which are unclaimed, and possible duplicates.",
    url: "/dashboard/sponsors",
    icon: IconBuildingStore,
    allowedRoles: ["app_admin"],
    group: "commercial",
  },
  {
    // Sponsored copy is the only content on the platform reviewed BEFORE it is
    // published rather than after it is reported. It is paid third-party
    // messaging in a pseudonymous room, so the flag queue is the wrong shape:
    // by the time a flag exists an attendee has already read it.
    title: "Creative review",
    description: "Sponsored copy waiting to be read by a person. Oldest first.",
    url: "/dashboard/creative-review",
    icon: IconFlag,
    allowedRoles: ["app_admin"],
    group: "decisions",
    // The only entry in this group that had no badge, so the one queue where
    // a waiting sponsor was invisible from every other screen. It came free
    // with `lib/attention-queues.ts` counting all four.
    badgeKey: "pendingCreative",
  },
  {
    // A ledger, not a checkout. It lists PLACEMENTS rather than charges, because
    // the row that matters is the one that ran and was never priced.
    title: "Charges",
    description: "What each placement costs, what has been agreed, and what has been paid.",
    url: "/dashboard/charges",
    icon: IconReceipt,
    allowedRoles: ["app_admin"],
    group: "commercial",
  },
  {
    title: "Applications",
    description: "Host applications awaiting review. Every one is read by a person.",
    url: "/dashboard/onboarding",
    icon: IconInbox,
    allowedRoles: ["app_admin"],
    group: "decisions",
    badgeKey: "pendingApplications",
  },
  {
    title: "Organisations",
    description: "Every host organisation — members, domains, and suspension.",
    url: "/dashboard/organisations",
    icon: IconBuilding,
    allowedRoles: ["app_admin"],
    group: "supply",
  },
  {
    // The host's own copy of the above. Two screens rather than one with a
    // branch: an admin managing the platform and an owner managing their own
    // company want different things on screen, and the audit trail should say
    // which of the two acted.
    title: "My organisation",
    description: "Your colleagues, invites, and domain verification.",
    url: "/dashboard/organisation",
    icon: IconBuilding,
    allowedRoles: ["organizer", "venue_owner", "sponsor"],
    group: "setup",
  },
  {
    // Categories were seeded by a script and by nothing else — an admin could
    // not fix a typo or retire a dead one.
    title: "Categories",
    description: "The two-level taxonomy events are filtered by on the app.",
    url: "/dashboard/categories",
    icon: IconCategory,
    allowedRoles: ["app_admin"],
    group: "setup",
  },
  {
    title: "Amenities",
    description:
      "What an event offers. Retiring one stops it being offered without rewriting the events that already list it.",
    url: "/dashboard/amenities",
    icon: IconCategory,
    allowedRoles: ["app_admin"],
    group: "setup",
  },
  {
    // The login page has always advertised "Exportable reporting". Until now
    // nothing in the product exported anything.
    title: "Reports",
    description: "Download events, attendance, ratings and moderation as CSV.",
    url: "/dashboard/reports",
    icon: IconFileSpreadsheet,
    allowedRoles: ["app_admin", "organizer", "venue_owner"],
    group: "record",
  },
  {
    // `audit_logs` was written by every sensitive action and read by nothing.
    // Hosts see only their own organisation's activity; the scoping is enforced
    // in lib/audit-actions.ts rather than by hiding the link.
    title: "Audit log",
    description: "Who did what, when. Written automatically and never editable.",
    url: "/dashboard/audit",
    icon: IconHistory,
    allowedRoles: ["app_admin", "organizer", "venue_owner"],
    group: "record",
  },
]

/**
 * Reachable but not in the sidebar.
 *
 * Settings is reached from the account menu, where people look for it, and a
 * nav item would be a second door to the same room. It is listed here so the
 * route inventory stays honest — a screen with no entry in either list is one
 * nobody can find.
 */
export const unlistedRoutes = ["/dashboard/settings", "/dashboard/venue-owners"] as const

/** Fails closed: an unknown or absent role sees nothing. */
export function visibleNavFor(role: string | undefined): DashboardNavItem[] {
  if (!role) return []
  return dashboardNav.filter((item) => item.allowedRoles.includes(role as DashboardRole))
}

/**
 * The same items, under their headings, with empty groups dropped.
 *
 * Dropping is the part that matters. A sponsor sees three destinations; four
 * empty headings above them would be worse than no headings at all, and it is
 * exactly what a static group list produces once the role gate has run.
 */
export function groupedNavFor(
  role: string | undefined
): { label: string | null; items: DashboardNavItem[] }[] {
  const visible = visibleNavFor(role)
  const out: { label: string | null; items: DashboardNavItem[] }[] = []

  const ungrouped = visible.filter((i) => !i.group)
  if (ungrouped.length) out.push({ label: null, items: ungrouped })

  for (const { key, label } of NAV_GROUPS) {
    const items = visible.filter((i) => i.group === key)
    if (items.length) out.push({ label, items })
  }
  return out
}

/**
 * May this role reach this route at all?
 *
 * The nav already declares `allowedRoles` per item, and the pages gated
 * themselves separately — so `/dashboard/brand` and `/dashboard/placements`
 * called `canAccessDashboard`, which is true for all four dashboard roles,
 * while the nav presented both as sponsor-only. The link was hidden and the
 * URL worked, which is the worst combination: invisible to the people who
 * should use it and open to everyone else.
 *
 * Deriving the gate from the same list that draws the menu means the two
 * cannot disagree again. Fails closed for an unknown role and for a route with
 * no nav entry, because a page nobody declared is a page nobody reasoned about.
 *
 * Unlisted routes are deliberately not covered: `/dashboard/settings` and
 * `/dashboard/venue-owners` are reachable without appearing in the menu, so
 * they carry their own gates.
 */
export function mayReachRoute(role: string | undefined, url: string): boolean {
  if (!role) return false
  /*
   * A declared entry always wins, and it is checked FIRST.
   *
   * `/dashboard/venue-owners` is both unlisted and in the nav, so testing the
   * unlisted set first let it bypass its own `allowedRoles` for every role —
   * a gate that opened the one route it was asked about. The equivalence test
   * caught it immediately, which is the argument for asserting the property
   * rather than a handful of cases.
   */
  /*
   * `some`, not `find`. `/dashboard/venues` has TWO entries — one for
   * `venue_owner` and one for `app_admin` — because it is one URL that frames
   * itself differently per role, and the menu deliberately describes it
   * differently to each. Taking the first match denied the admin their own
   * venue index while the menu was still offering it.
   */
  const declared = dashboardNav.filter((i) => i.url === url)
  if (declared.length > 0) {
    return declared.some((i) => i.allowedRoles.includes(role as DashboardRole))
  }
  // No entry: reachable only if it is deliberately unlisted and carries its own
  // gate. Anything else is a page nobody declared, and so nobody reasoned about.
  return (unlistedRoutes as readonly string[]).includes(url)
}
