import { redirect } from "next/navigation"

import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { attentionQueues } from "@/lib/attention-queues-query"
import { queueBadges } from "@/lib/attention-queues"
import { getAuth } from "@/lib/auth"
import { canAccessDashboard } from "@/lib/rbac"

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
  const badges = isAdmin ? queueBadges(await attentionQueues()) : {}

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
      <SidebarInset className="overflow-hidden border border-border bg-background">
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
