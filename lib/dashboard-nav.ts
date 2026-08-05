import {
  IconBuildingStore,
  IconDashboard,
  IconFlag,
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
  /** Renders a count next to the item; only Moderation uses it today. */
  badgeKey?: "pendingFlags"
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
    description: "Role-based reporting across platform, organisers, and venues.",
    url: "/dashboard",
    icon: IconDashboard,
    allowedRoles: ["app_admin", "organizer", "venue_owner"],
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
    description: "Manage event setup, publishing status, and operational detail.",
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
    title: "Chatrooms",
    description: "Per-event rooms: activity, flags, and moderation.",
    url: "/dashboard/chatrooms",
    icon: IconMessage2,
    // venue_owner belongs here: `canModerateChat` in lib/rbac.ts grants venue
    // owners moderation over their own events, and the messaging page gates on
    // `canManageEvent`, which agrees.
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
    title: "Venue owners",
    description: "Venue-owner accounts and their portfolios.",
    url: "/dashboard/venue-owners",
    icon: IconBuildingStore,
    allowedRoles: ["app_admin"],
  },
]

/** Fails closed: an unknown or absent role sees nothing. */
export function visibleNavFor(role: string | undefined): DashboardNavItem[] {
  if (!role) return []
  return dashboardNav.filter((item) => item.allowedRoles.includes(role as DashboardRole))
}
