"use client"

import * as React from "react"
import { useSession } from "next-auth/react"

import { BrandLogo } from "@/components/brand-logo"
import { NavMain } from "@/components/nav-main"
import { NavUser } from "@/components/nav-user"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
} from "@/components/ui/sidebar"
import { visibleNavFor } from "@/lib/dashboard-nav"

const ROLE_LABELS: Record<string, string> = {
  app_admin: "Platform",
  organizer: "Organiser",
  venue_owner: "Venue owner",
}

/**
 * `badges` comes from the server layout rather than a client fetch, so the
 * moderation count is correct on first paint instead of popping in — an alert
 * that arrives late is one the operator has already scrolled past.
 */
export function AppSidebar({
  badges,
  ...props
}: React.ComponentProps<typeof Sidebar> & { badges?: Record<string, number> }) {
  const { data: session } = useSession()
  const role = session?.user?.role
  const nav = visibleNavFor(role)

  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader className="gap-0 px-3 py-3">
        <BrandLogo size="sidebar" />
        {role ? (
          <p className="mt-2 px-0.5 text-[0.6875rem] font-medium uppercase tracking-[0.14em] text-faint-foreground">
            {ROLE_LABELS[role] ?? role}
          </p>
        ) : null}
      </SidebarHeader>
      <SidebarContent className="py-1">
        <NavMain items={nav} badges={badges} />
      </SidebarContent>
      <SidebarFooter className="px-2 pb-2">
        <NavUser
          user={{
            name: session?.user?.name ?? "Blend'n",
            email: session?.user?.email ?? "",
            avatar: session?.user?.image ?? "",
            role,
          }}
        />
      </SidebarFooter>
    </Sidebar>
  )
}
