import { redirect } from "next/navigation"

import { AppSidebar } from "@/components/app-sidebar"
import { RoutePageHeader } from "@/components/dashboard/route-page-header"
import { OrgSuspendedNotice } from "@/components/org-suspended-notice"
import { SiteHeader } from "@/components/site-header"
import { SidebarProvider } from "@/components/ui/sidebar"
import { attentionQueues } from "@/lib/attention-queues-query"
import { planBadgeFor } from "@/lib/billing"
import { queueBadges } from "@/lib/attention-queues"
import { getAuth } from "@/lib/auth"
import { mayCreateEventsWith } from "@/lib/event-ownership"
import { logger } from "@/lib/logger"
import { activeOrgsFor, suspendedOrgsFor } from "@/lib/org-membership"
import { canAccessDashboard } from "@/lib/rbac"

/**
 * A badge is decoration on the nav; the nav is the way to every screen.
 *
 * `attentionQueues()` is eight aggregates in one `Promise.all`, and this
 * layout wraps every dashboard route — so one rejection (a table the running
 * code knows and the database does not yet, for the seconds between a deploy's
 * migrate and its boot) used to 500 the whole admin shell rather than one
 * count. Logged, not swallowed: an empty strip that says nothing is the
 * "Moderation queue is clear" bug this module was written to fix, so the
 * failure has to land somewhere a person looks.
 */
async function attentionQueuesOrNone() {
  try {
    return await attentionQueues()
  } catch (error) {
    logger.error("attention queues failed; rendering the nav without badges", {
      error: error instanceof Error ? error.message : String(error),
    })
    return []
  }
}

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await getAuth()
  if (!session?.user || !canAccessDashboard(session.user.role)) {
    redirect("/login")
  }

  /*
   * Only admins have these nav items, so only they pay for the counts.
   *
   * Read from `lib/attention-queues.ts` rather than counted here, because these
   * badges and the overview's attention strip are the same question and used to
   * be two implementations of it. The strip counted `moderation_flags` alone
   * and printed "Moderation queue is clear" next to this sidebar showing
   * `Claims 4` and `Applications 7`.
   *
   * Counted in the server layout rather than by a client effect — an alert that
   * pops in after paint is one the operator has already scrolled past.
   */
  const user = session.user
  const isAdmin = user.role === "app_admin"
  const [badges, suspended, orgs] = await Promise.all([
    isAdmin ? attentionQueuesOrNone().then(queueBadges) : {},
    // A member of a suspended organisation is told on every page, not left to
    // work it out from an empty events list (SCRUM-8).
    isAdmin ? [] : suspendedOrgsFor(user.id),
    // The sidebar's identity card and the first breadcrumb: the home
    // organisation first, the one a new event belongs to.
    isAdmin ? [] : activeOrgsFor(user.id),
  ])
  // The top bar's Create event pill asks what every other door to the event
  // form asks (SCRUM-145), from the memberships already loaded: the first live
  // one is `homeOrgIdFor`'s answer, by the same order.
  const canCreate = mayCreateEventsWith(user.role, orgs.length > 0)
  // Who this person acts for, said once for the card and the first crumb. A
  // member only of a suspended organisation still belongs to it — the notice
  // below says why the controls are gone — and someone in none is told so.
  // The sidebar's plan card: organisers only, for the home organisation the
  // card above it names (venue plans are step 17's).
  // Decoration like the badges: a failure logs and drops the card, never the shell.
  const plan =
    user.role === "organizer" && orgs[0]
      ? await planBadgeFor(orgs[0].id)
          .then((b) => ({ analytics: b.analytics, date: b.date ? { word: b.date.word, at: b.date.at.toISOString() } : null }))
          .catch((error: unknown) => {
            logger.error("plan badge failed; rendering the nav without the plan card", {
              error: error instanceof Error ? error.message : String(error),
            })
            return null
          })
      : null
  const actingFor = isAdmin
    ? "Blend'n"
    : (orgs[0]?.display_name ?? suspended[0]?.display_name ?? "No organisation")

  return (
    // 248px, the kit's sidebar. Flush: no inset card, no margin, no shadow.
    <SidebarProvider style={{ "--sidebar-width": "248px" } as React.CSSProperties}>
      {/*
        The first stop for a keyboard: past the sidebar and the top bar,
        straight to the page. Hidden until focused.
      */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground"
      >
        Skip to content
      </a>
      <AppSidebar
        role={user.role}
        org={actingFor}
        otherOrgs={Math.max(orgs.length - 1, 0)}
        badges={badges}
        plan={plan}
      />
      {/*
        `overflow-x-clip`, not `overflow-hidden`: hidden makes this column a
        scroll container, and a sticky element inside one sticks to it rather
        than to the viewport -- the event form's publish rail scrolled away
        with the page, and the top bar would too. Clip still cuts anything
        wider than the column; it just is not a scroller.

        `min-w-0` because clip is not a scroller: `min-width: auto` on this
        flex item still resolves to its content's min-content width. On a 768px
        viewport with the sidebar open, a nowrap subtitle once made this column
        77px wider than its slot -- the page scrolled sideways and the account
        button sat past the right edge.
      */}
      <div className="flex min-w-0 flex-1 flex-col overflow-x-clip bg-background">
        <SiteHeader
          role={user.role}
          user={{ name: user.name ?? "Blend'n", email: user.email ?? "", image: user.image }}
          org={actingFor}
          canCreate={canCreate}
        />
        {/*
          @container/main is what every dashboard grid keys off. The sidebar is
          248px and collapsible, so viewport width and content width differ by a
          large, changing amount — grids keyed to viewport breakpoints reflow at
          different points from grids keyed to the container and visibly fall
          out of step with each other.

          The kit's frame: 1200 wide at most, 28/32/56 padding, 24 between
          blocks. Narrower padding below 768, where 32px a side would leave a
          375px phone 311px of content.
        */}
        {/* `tabIndex={-1}` so the skip link moves focus here, not just the scroll. */}
        <main
          id="main"
          tabIndex={-1}
          className="@container/main mx-auto flex w-full max-w-[1200px] flex-1 flex-col gap-6 px-4 pb-10 pt-5 outline-none md:px-8 md:pb-14 md:pt-7"
        >
          <RoutePageHeader role={user.role} />
          <OrgSuspendedNotice orgs={suspended} />
          {children}
        </main>
      </div>
    </SidebarProvider>
  )
}
