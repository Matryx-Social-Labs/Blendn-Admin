import { redirect } from "next/navigation"

import { AppSidebar } from "@/components/app-sidebar"
import { SiteHeader } from "@/components/site-header"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
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

  // Only admins have these nav items, so only they pay for the counts.
  const isAdmin = session.user.role === "app_admin"
  // The badge covers both moderation queues. Counting only flags would leave a
  // harassment report with no number anywhere in the chrome — and a report is
  // the one of the two with a person waiting on the other end.
  const [
    flagCount,
    userReportCount,
    messageReportCount,
    pendingApplications,
    eventClaims,
    venueClaims,
    brandClaims,
  ] = isAdmin
    ? await Promise.all([
        db.moderation_flags.count({ where: { status: "pending" } }),
        db.user_reports.count({ where: { status: "pending" } }),
        db.message_reports.count({ where: { status: "pending" } }),
        db.organiser_onboarding_requests.count({
          where: { status: { in: ["pending", "email_pending"] } },
        }),
        db.event_claims.count({ where: { status: "pending" } }),
        db.venue_claims.count({ where: { status: "pending" } }),
        db.sponsor_claims.count({ where: { status: "pending" } }),
      ])
    : [0, 0, 0, 0, 0, 0, 0]
  const pendingFlags = flagCount + userReportCount + messageReportCount
  /*
   * All THREE claim queues in one number, for the same reason the moderation
   * badge covers both of its queues: the nav has one entry, so a count that
   * covered only part of it would leave somebody waiting with no number
   * anywhere in the chrome. Brands joined when they moved into the shared
   * queue — a tab whose count was missing from the badge would be the same
   * defect at a smaller scale.
   *
   * Counted in the server layout rather than by a client effect -- an alert
   * that pops in after paint is one the operator has already scrolled past.
   */
  const pendingClaims = eventClaims + venueClaims + brandClaims

  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": "calc(var(--spacing) * 60)",
          "--header-height": "calc(var(--spacing) * 12)",
        } as React.CSSProperties
      }
    >
      <AppSidebar variant="inset" badges={{ pendingFlags, pendingApplications, pendingClaims }} />
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
