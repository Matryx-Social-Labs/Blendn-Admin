"use client"

import { useMemo } from "react"
import { usePathname } from "next/navigation"
import { useSession } from "next-auth/react"

import { BrandLogo } from "@/components/brand-logo"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"

const routeContent: Record<string, { title: string; description: string }> = {
  "/dashboard": {
    title: "Performance Overview",
    description: "Live reporting across growth, attendance, and event activity.",
  },
  "/dashboard/events": {
    title: "Events",
    description: "Manage event supply, publishing status, and operational detail.",
  },
  "/dashboard/users": {
    title: "Users",
    description: "Track onboarding, verification, and user activity quality.",
  },
  "/dashboard/organisers": {
    title: "Organisers",
    description: "Review host activity, publishing cadence, and account coverage.",
  },
  "/dashboard/venue-owners": {
    title: "Venue Owners",
    description: "Understand venue portfolios and their event contribution.",
  },
}

const roleLabels: Record<string, string> = {
  app_admin: "App Admin",
  organizer: "Organiser",
  venue_owner: "Venue Owner",
}

export function SiteHeader() {
  const pathname = usePathname()
  const { data: session } = useSession()

  const content = useMemo(() => {
    const exact = routeContent[pathname]
    if (exact) return exact

    if (pathname.startsWith("/dashboard/events/")) {
      return {
        title: "Event Workspace",
        description: "Inspect event setup, messaging, and performance detail.",
      }
    }

    return routeContent["/dashboard"]
  }, [pathname])

  const today = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date())

  return (
    <header className="sticky top-0 z-20 border-b border-white/10 bg-[#090909]/70 backdrop-blur-xl transition-[width,height] ease-linear">
      <div className="flex h-(--header-height) w-full items-center gap-3 px-4 lg:px-6">
        <SidebarTrigger className="-ml-1 rounded-full border border-white/10 bg-white/5 text-white hover:bg-white/10" />
        <Separator
          orientation="vertical"
          className="data-[orientation=vertical]:h-5 data-[orientation=vertical]:bg-white/10"
        />

        <div className="min-w-0 flex-1">
          <p className="text-[0.68rem] font-semibold uppercase tracking-[0.22em] text-white/42">
            {content.title}
          </p>
          <div className="flex items-center gap-3">
            <h1 className="truncate text-lg font-semibold text-white">{content.description}</h1>
          </div>
        </div>

        <div className="hidden items-center gap-3 md:flex">
          <div className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-white/60">
            {session?.user?.role ? roleLabels[session.user.role] ?? session.user.role : "Workspace"}
          </div>
          <div className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-white/62">
            {today}
          </div>
          <BrandLogo compact className="hidden xl:flex" />
        </div>
      </div>
    </header>
  )
}
