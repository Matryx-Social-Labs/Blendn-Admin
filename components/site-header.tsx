"use client"

import { Fragment } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { IconChevronRight, IconPlus } from "@tabler/icons-react"

import { AccountMenu } from "@/components/account-menu"
import { CommandPalette, CommandPaletteTrigger } from "@/components/command-palette"
import { Button } from "@/components/ui/button"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { breadcrumbsFor } from "@/lib/dashboard-route-content"
import { cn } from "@/lib/utils"

/**
 * What ⌘K can find, said in the field. A host's search returns their events
 * (and a venue owner's venues) and never people — `/api/search` is admin-only
 * for accounts — so promising people to a host would be a field that lies.
 */
function searchPlaceholder(role: string): string {
  if (role === "app_admin") return "Search events, people…"
  if (role === "venue_owner") return "Search events, venues…"
  return "Search events…"
}

/**
 * The top bar: 60px, sticky, on every dashboard route (the kit's `Topbar`).
 *
 * Breadcrumbs on the left, then search, then Create event, then the account.
 * The page's name is not here any more: it is the `h1` in the content area's
 * `PageHeader` (R5), and the last crumb is the same word from the same map.
 *
 * The sidebar toggle stays at every width. Below 768 it is the only way to the
 * nav (a sheet); above, it is how a 768px screen gets its 248px back, and
 * without it ⌘B would hide the sidebar with nothing on screen to bring it back.
 *
 * Everything is passed in from the server layout rather than read from
 * `useSession`, whose first render has no session — the role-dependent copy
 * and the Create pill would otherwise arrive after paint.
 */
export function SiteHeader({
  role,
  user,
  org,
  canCreate,
}: {
  role: string
  user: { name: string; email: string; image?: string | null }
  /** The first breadcrumb: the organisation acted for, or Blend'n for admins. */
  org: string
  /** `mayCreateEvents` (SCRUM-145): the pill only for an account that could save one. */
  canCreate: boolean
}) {
  const pathname = usePathname()
  const crumbs = breadcrumbsFor(pathname, role, org)
  const placeholder = searchPlaceholder(role)

  return (
    // A container, because what fits is the bar's width, not the window's: at
    // 768 the sidebar leaves it 520px, the same as a 520px phone would have.
    <header className="@container/topbar sticky top-0 z-20 flex h-[60px] shrink-0 items-center gap-3 border-b border-border bg-background/95 px-4 backdrop-blur-xl md:px-8">
      <SidebarTrigger className="-ml-1.5 size-8 shrink-0" />

      <nav aria-label="Breadcrumb" className="min-w-0 flex-1 overflow-hidden">
        <ol className="flex min-w-0 items-center gap-2 text-[0.8125rem]">
          {crumbs.map((crumb, i) => {
            const last = i === crumbs.length - 1
            // In a narrow bar only the page you are on: the trail would push
            // the search and the account off the edge.
            const hideOnPhone = !last && "@max-xl/topbar:hidden"
            return (
              <Fragment key={`${i}-${crumb.label}`}>
                {i > 0 ? (
                  // Hidden with the trail: in a narrow bar there is one crumb
                  // and nothing to separate.
                  <li aria-hidden="true" className="shrink-0 text-faint-foreground @max-xl/topbar:hidden">
                    <IconChevronRight className="size-3.5" />
                  </li>
                ) : null}
                <li className={cn("min-w-0 truncate", !last && "max-w-48", hideOnPhone)}>
                  {crumb.href ? (
                    <Link
                      href={crumb.href}
                      className="whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {crumb.label}
                    </Link>
                  ) : (
                    <span aria-current="page" className="truncate whitespace-nowrap text-foreground">
                      {crumb.label}
                    </span>
                  )}
                </li>
              </Fragment>
            )
          })}
        </ol>
      </nav>

      <CommandPalette placeholder={placeholder} />
      <CommandPaletteTrigger placeholder={placeholder} />

      {canCreate ? (
        <Button asChild pill icon={<IconPlus aria-hidden />} className="@max-3xl/topbar:px-2.5">
          <Link href="/dashboard/events/new">
            <span className="@max-3xl/topbar:sr-only">Create event</span>
          </Link>
        </Button>
      ) : null}

      <AccountMenu
        name={user.name}
        email={user.email}
        image={user.image}
        showOrganisation={role === "organizer" || role === "venue_owner"}
      />
    </header>
  )
}
