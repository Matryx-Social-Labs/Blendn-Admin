"use client"

import { useEffect } from "react"
import { usePathname } from "next/navigation"

import { BrandLogo } from "@/components/brand-logo"
import { NavMain } from "@/components/nav-main"
import { Sidebar, SidebarContent, SidebarHeader, useSidebar } from "@/components/ui/sidebar"
import { groupedNavFor } from "@/lib/dashboard-nav"

const ROLE_LABELS: Record<string, string> = {
  app_admin: "Platform",
  organizer: "Organiser",
  venue_owner: "Venue owner",
  sponsor: "Sponsor",
}

function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join("") || "B"
  )
}

/**
 * The flush 248px sidebar (the kit's `Sidebar`): logo, the organisation you
 * act as, then the nav.
 *
 * ## The identity card names one organisation, and switches nothing
 *
 * The kit draws an organisation switcher. Here every read is scoped to the
 * union of a person's live memberships (`actorFor`), so there is no "current
 * organisation" for a switcher to change. The card names the home one — the
 * oldest membership, which is where a new event is created — and says how many
 * others there are. A switcher arrives with a current-organisation model, not
 * before.
 *
 * No plan card yet: the free/Analytics split lands in step 16.
 *
 * Role, organisation and badges all come from the server layout, so the nav is
 * right on first paint; `useSession` has no session on its first render. Still
 * a client component: the nav items carry icon components and `isActive`
 * functions, which cannot cross from a server component to `NavMain`.
 */
export function AppSidebar({
  role,
  org,
  otherOrgs,
  badges,
}: {
  role: string
  /** Who this person acts for: the home organisation, Blend'n for an admin. */
  org: string
  /** How many further live organisations this person belongs to. */
  otherOrgs: number
  badges?: Record<string, number>
}) {
  const groups = groupedNavFor(role)

  /*
   * Below 768 the nav is a modal sheet, and following a link in it used to
   * leave it open over the page it had just opened. Closed on every change of
   * route, which also covers a route reached any other way while it is open.
   */
  const pathname = usePathname()
  const { setOpenMobile } = useSidebar()
  useEffect(() => {
    setOpenMobile(false)
  }, [pathname, setOpenMobile])
  const roleLabel = ROLE_LABELS[role] ?? role

  return (
    <Sidebar collapsible="offcanvas">
      {/*
        One navigation landmark around the whole column, card included, so
        nothing in the sidebar sits outside a landmark (axe `region`). Its
        name says what it is next to the breadcrumb nav in the top bar.
      */}
      <nav aria-label="Dashboard" className="flex min-h-0 flex-1 flex-col">
        <SidebarHeader className="gap-[18px] px-3 pb-0 pt-4">
          <div className="px-1.5">
            <BrandLogo size="sidebar" />
          </div>
          <div data-slot="org-card" className="flex items-center gap-2.5 rounded-[10px] border border-border bg-card p-2.5">
            <span
              aria-hidden="true"
              className="flex size-[30px] shrink-0 items-center justify-center rounded-md bg-surface-raised text-[0.75rem] font-bold"
            >
              {initialsOf(org)}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span data-slot="org-card-name" className="truncate text-[0.8125rem] font-bold">{org}</span>
              <span data-slot="org-card-role" className="truncate text-[0.65625rem] font-medium uppercase tracking-[0.1em] text-faint-foreground">
                {roleLabel}
                {otherOrgs > 0 ? ` · +${otherOrgs} more` : null}
              </span>
            </span>
          </div>
        </SidebarHeader>
        <SidebarContent className="gap-3.5 px-3 py-[18px]">
          {groups.map((group) => (
            <NavMain
              key={group.label ?? "top"}
              label={group.label}
              items={group.items}
              badges={badges}
            />
          ))}
        </SidebarContent>
      </nav>
    </Sidebar>
  )
}
