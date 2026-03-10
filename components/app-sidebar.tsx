"use client"

import * as React from "react"
import {
  IconBuildingStore,
  IconChartHistogram,
  IconDashboard,
  IconListDetails,
  IconMessage2,
  IconMicrophone2,
  IconUsers,
} from "@tabler/icons-react"
import { useSession } from "next-auth/react"

import { BrandLogo } from "@/components/brand-logo"
import { NavMain } from "@/components/nav-main"
import { NavUser } from "@/components/nav-user"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarSeparator,
} from "@/components/ui/sidebar"

const navMain = [
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
    isActive: (pathname: string) =>
      pathname === "/dashboard/events" ||
      pathname === "/dashboard/events/new" ||
      (pathname.startsWith("/dashboard/events/") && !pathname.endsWith("/messaging")),
  },
  {
    title: "Chatrooms",
    description: "Select a live event and manage chatroom messaging.",
    url: "/dashboard/chatrooms",
    icon: IconMessage2,
    allowedRoles: ["app_admin", "organizer"],
    isActive: (pathname: string) =>
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

const roleContent: Record<string, { label: string; description: string }> = {
  app_admin: {
    label: "Platform view",
    description: "Growth, attendance, and operator reporting across the platform.",
  },
  organizer: {
    label: "Organiser view",
    description: "Attendance, demand, chat activity, and event engagement signals.",
  },
  venue_owner: {
    label: "Venue view",
    description: "Venue mix, fill rate, and event portfolio performance.",
  },
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { data: session } = useSession()
  const role = session?.user?.role
  const roleMeta = role ? roleContent[role] : null

  const filteredNav = navMain.filter(
    (item) => role && item.allowedRoles.includes(role)
  )

  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader className="gap-3 px-3 py-4">
        <SidebarMenu>
          <SidebarMenuItem>
            <div className="rounded-[1.6rem] border border-white/10 bg-white/[0.04] p-4">
              <BrandLogo size="sidebar" showTagline />
              {roleMeta ? (
                <div className="mt-4 rounded-[1.2rem] border border-white/8 bg-black/20 p-3">
                  <p className="text-[0.68rem] font-semibold uppercase tracking-[0.22em] text-white/42">
                    {roleMeta.label}
                  </p>
                  <p className="mt-2 text-sm leading-6 text-white/70">
                    {roleMeta.description}
                  </p>
                </div>
              ) : null}
            </div>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarSeparator />
      <SidebarContent className="px-2 py-2">
        <NavMain items={filteredNav} />
      </SidebarContent>
      <SidebarFooter className="px-3 pb-3">
        <div className="rounded-[1.4rem] border border-white/10 bg-gradient-to-br from-white/[0.06] to-white/[0.02] p-3">
          <div className="mb-3 flex items-center gap-2 text-white/54">
            <IconChartHistogram className="size-4" />
            <span className="text-xs font-semibold uppercase tracking-[0.22em]">
              Live reporting
            </span>
          </div>
          <NavUser
            user={{
              name: session?.user?.name ?? "Blend'n",
              email: session?.user?.email ?? "",
              avatar: session?.user?.image ?? "",
              role,
            }}
          />
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}
