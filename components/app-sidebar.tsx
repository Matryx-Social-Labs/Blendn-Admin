"use client"

import * as React from "react"
import { IconChartHistogram } from "@tabler/icons-react"
import { useSession } from "next-auth/react"

import { BrandLogo } from "@/components/brand-logo"
import { NavMain } from "@/components/nav-main"
import { NavUser } from "@/components/nav-user"
import { visibleNavFor } from "@/lib/dashboard-nav"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarSeparator,
} from "@/components/ui/sidebar"

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
  const filteredNav = visibleNavFor(role)

  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader className="gap-3 px-3 py-4">
        <SidebarMenu>
          <SidebarMenuItem>
            <div className="rounded-xl border border-border bg-card p-4">
              <BrandLogo size="sidebar" showTagline />
              {roleMeta ? (
                <div className="mt-4 rounded-lg border border-border bg-muted p-3">
                  <p className="text-[0.68rem] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                    {roleMeta.label}
                  </p>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">
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
        <div className="rounded-xl border border-border bg-muted/50 p-3">
          <div className="mb-3 flex items-center gap-2 text-muted-foreground">
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
