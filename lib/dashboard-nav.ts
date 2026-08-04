import {
  IconBuildingStore,
  IconDashboard,
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
  isActive?: (pathname: string) => boolean
}

/**
 * Lives here rather than inside `components/app-sidebar.tsx` so the role gate
 * can be tested without mounting a client component that wants a NextAuth
 * session. The gate had drifted from `lib/rbac.ts` once already — see the
 * Chatrooms entry.
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
    title: "Chatrooms",
    description: "Select a live event and manage chatroom messaging.",
    url: "/dashboard/chatrooms",
    icon: IconMessage2,
    // venue_owner belongs here: `canModerateChat` in lib/rbac.ts grants venue
    // owners moderation over their own events, and the messaging page gates on
    // `canManageEvent`, which agrees. Only this nav list and the chatrooms
    // index disagreed, so a venue owner was locked out of a screen the
    // authorization layer had always been willing to serve them.
    allowedRoles: ["app_admin", "organizer", "venue_owner"],
    isActive: (pathname) =>
      pathname === "/dashboard/chatrooms" || pathname.endsWith("/messaging"),
  },
  {
    title: "Users",
    description: "Monitor onboarding, verification, and user activity.",
    url: "/dashboard/users",
    icon: IconUsers,
    allowedRoles: ["app_admin"],
  },
  {
    title: "Organisers",
    description: "See host supply, publishing activity, and account readiness.",
    url: "/dashboard/organisers",
    icon: IconMicrophone2,
    allowedRoles: ["app_admin"],
  },
  {
    title: "Venue Owners",
    description: "Review venue-side operators and event portfolio depth.",
    url: "/dashboard/venue-owners",
    icon: IconBuildingStore,
    allowedRoles: ["app_admin"],
  },
]

/** Fails closed: an unknown or absent role sees nothing. */
export function visibleNavFor(role: string | undefined): DashboardNavItem[] {
  if (!role) return []
  return dashboardNav.filter((item) =>
    item.allowedRoles.includes(role as DashboardRole)
  )
}
