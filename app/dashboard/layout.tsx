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

  // Only admins have a moderation nav item, so only they pay for the count.
  const pendingFlags =
    session.user.role === "app_admin"
      ? await db.moderation_flags.count({ where: { status: "pending" } })
      : 0

  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": "calc(var(--spacing) * 60)",
          "--header-height": "calc(var(--spacing) * 12)",
        } as React.CSSProperties
      }
    >
      <AppSidebar variant="inset" badges={{ pendingFlags }} />
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
