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
  IconUsers,
} from "@tabler/icons-react"

import type { DashboardRole } from "@/lib/dashboard-types"

export interface DashboardNavItem {
  title: string
  description: string
  url: string
  icon: typeof IconDashboard
  allowedRoles: DashboardRole[]
  /** Renders a count next to the item. */
  badgeKey?: "pendingFlags" | "pendingApplications"
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
    badgeKey: "pendingFlags",
  },
  {
    title: "Events",
    description: "Every event on the platform — search, filter, and drill in.",
    url: "/dashboard/events",
    icon: IconListDetails,
    allowedRoles: ["app_admin", "organizer", "venue_owner"],
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
  },
  {
    title: "My venues",
    description: "Utilisation, ratings and bookings — one section per venue.",
    url: "/dashboard/venues",
    icon: IconBuildingStore,
    allowedRoles: ["venue_owner"],
  },
  {
    // Sponsor-side. A sponsor sees their own placements and campaigns and
    // nothing else — not attendees, not moderation, not other people's events.
    title: "Placements",
    description: "Where your brand appears, and what is waiting on you.",
    url: "/dashboard/placements",
    icon: IconMicrophone2,
    allowedRoles: ["sponsor"],
  },
  {
    title: "Brand",
    description: "Your name, logo and website, as attendees see them.",
    url: "/dashboard/brand",
    icon: IconBuildingStore,
    allowedRoles: ["sponsor"],
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
    isActive: (pathname) =>
      pathname === "/dashboard/chatrooms" || pathname.endsWith("/messaging"),
  },
  {
    title: "Users",
    description: "Accounts, onboarding, and reachability.",
    url: "/dashboard/users",
    icon: IconUsers,
    allowedRoles: ["app_admin"],
  },
  {
    title: "Organisers",
    description: "The supply side: who publishes, and how concentrated it is.",
    url: "/dashboard/organisers",
    icon: IconMicrophone2,
    allowedRoles: ["app_admin"],
  },
  {
    title: "Venues",
    description: "Every venue record — who owns each, which are unclaimed, and open disputes.",
    url: "/dashboard/venue-owners",
    icon: IconBuildingStore,
    allowedRoles: ["app_admin"],
  },
  {
    title: "Leads",
    description: "Demo requests from the organiser landing page. Oldest untouched first.",
    url: "/dashboard/leads",
    icon: IconInbox,
    allowedRoles: ["app_admin"],
  },
  {
    title: "Venue claims",
    description:
      "Ownership requests. Approving one hands over the events other organisers hold there.",
    url: "/dashboard/venue-claims",
    icon: IconFileCheck,
    allowedRoles: ["app_admin"],
  },
  {
    title: "Applications",
    description: "Host applications awaiting review. Every one is read by a person.",
    url: "/dashboard/onboarding",
    icon: IconInbox,
    allowedRoles: ["app_admin"],
    badgeKey: "pendingApplications",
  },
  {
    title: "Organisations",
    description: "Every host organisation — members, domains, and suspension.",
    url: "/dashboard/organisations",
    icon: IconBuilding,
    allowedRoles: ["app_admin"],
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
  },
  {
    // Categories were seeded by a script and by nothing else — an admin could
    // not fix a typo or retire a dead one.
    title: "Categories",
    description: "The two-level taxonomy events are filtered by on the app.",
    url: "/dashboard/categories",
    icon: IconCategory,
    allowedRoles: ["app_admin"],
  },
  {
    // The login page has always advertised "Exportable reporting". Until now
    // nothing in the product exported anything.
    title: "Reports",
    description: "Download events, attendance, ratings and moderation as CSV.",
    url: "/dashboard/reports",
    icon: IconFileSpreadsheet,
    allowedRoles: ["app_admin", "organizer", "venue_owner"],
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
export const unlistedRoutes = ["/dashboard/settings"] as const

/** Fails closed: an unknown or absent role sees nothing. */
export function visibleNavFor(role: string | undefined): DashboardNavItem[] {
  if (!role) return []
  return dashboardNav.filter((item) => item.allowedRoles.includes(role as DashboardRole))
}
