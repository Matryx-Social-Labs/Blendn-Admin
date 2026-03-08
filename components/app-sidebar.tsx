"use client"

import * as React from "react"
import {
  IconBuildingStore,
  IconDashboard,
  IconFolder,
  IconInnerShadowTop,
  IconListDetails,
  IconMicrophone2,
  IconUsers,
} from "@tabler/icons-react"
import { useSession } from "next-auth/react"

import { NavMain } from "@/components/nav-main"
import { NavUser } from "@/components/nav-user"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"

const navMain = [
  {
    title: "Dashboard",
    url: "/dashboard",
    icon: IconDashboard,
    allowedRoles: ["app_admin", "organizer", "venue_owner"],
  },
  {
    title: "Events",
    url: "/dashboard/events",
    icon: IconListDetails,
    allowedRoles: ["app_admin", "organizer", "venue_owner"],
  },
  {
    title: "Users",
    url: "/dashboard/users",
    icon: IconUsers,
    allowedRoles: ["app_admin"],
  },
  {
    title: "Organisers",
    url: "/dashboard/organisers",
    icon: IconMicrophone2,
    allowedRoles: ["app_admin"],
  },
  {
    title: "Venue Owners",
    url: "/dashboard/venue-owners",
    icon: IconBuildingStore,
    allowedRoles: ["app_admin"],
  },
  {
    title: "Analytics",
    url: "/dashboard/analytics",
    icon: IconFolder,
    allowedRoles: ["app_admin"],
  },
  {
    title: "Team",
    url: "/dashboard/team",
    icon: IconUsers,
    allowedRoles: ["app_admin"],
  },
]

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { data: session } = useSession()
  const role = session?.user?.role

  const filteredNav = navMain.filter(
    (item) => role && item.allowedRoles.includes(role)
  )

  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              className="data-[slot=sidebar-menu-button]:!p-1.5"
            >
              <a href="#">
                <IconInnerShadowTop className="!size-5" />
                <span className="text-base font-semibold">Blendn Admin</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={filteredNav} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={{
          name: session?.user?.name ?? "Admin",
          email: session?.user?.email ?? "",
          avatar: session?.user?.image ?? "",
          role: role,
        }} />
      </SidebarFooter>
    </Sidebar>
  )
}
