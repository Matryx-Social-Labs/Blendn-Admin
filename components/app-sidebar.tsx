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
  },
  {
    title: "Events",
    url: "/dashboard/events",
    icon: IconListDetails,
  },
  {
    title: "Users",
    url: "/dashboard/users",
    icon: IconUsers,
    adminOnly: true,
  },
  {
    title: "Organisers",
    url: "/dashboard/organisers",
    icon: IconMicrophone2,
    adminOnly: true,
  },
  {
    title: "Venue Owners",
    url: "/dashboard/venue-owners",
    icon: IconBuildingStore,
    adminOnly: true,
  },
  {
    title: "Analytics",
    url: "/dashboard/analytics",
    icon: IconFolder,
  },
  {
    title: "Team",
    url: "/dashboard/team",
    icon: IconUsers,
  },
]

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const { data: session } = useSession()
  const role = session?.user?.role

  const filteredNav = navMain.filter(
    (item) => !item.adminOnly || role === "app_admin"
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
