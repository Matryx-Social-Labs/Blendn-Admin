import { redirect } from "next/navigation"

import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { attentionQueues } from "@/lib/attention-queues-query"
import { queueBadges } from "@/lib/attention-queues"
import { getAuth } from "@/lib/auth"
import { logger } from "@/lib/logger"
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
  const isAdmin = session.user.role === "app_admin"
  const badges = isAdmin ? queueBadges(await attentionQueuesOrNone()) : {}

  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": "calc(var(--spacing) * 60)",
          "--header-height": "calc(var(--spacing) * 12)",
        } as React.CSSProperties
      }
    >
      <AppSidebar variant="inset" badges={badges} />
      {/*
        `overflow-x-clip`, not `overflow-hidden`: hidden makes the inset a
        scroll container, and a sticky element inside one sticks to it rather
        than to the viewport -- the event form's publish rail scrolled away
        with the page. Clip still cuts anything wider than the inset and still
        keeps the rounded corners clean; it just is not a scroller.
      */}
      <SidebarInset className="overflow-x-clip border border-border bg-background">
        <SiteHeader />
        {/*
          @container/main is what every dashboard grid keys off. The sidebar is
          240px and collapsible, so viewport width and content width differ by a
          large, changing amount — grids keyed to viewport breakpoints reflow at
          different points from grids keyed to the container and visibly fall
          out of step with each other.
        */}
        <main className="@container/main flex flex-1 flex-col px-4 pb-10 pt-5 lg:px-6">
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  )
}
