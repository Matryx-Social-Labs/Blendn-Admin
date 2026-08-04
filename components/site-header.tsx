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
  "/dashboard/chatrooms": {
    title: "Chatrooms",
    description: "Choose a live event and open its chatroom workspace.",
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

    if (pathname.startsWith("/dashboard/events/") && pathname.endsWith("/messaging")) {
      return {
        title: "Chatroom Management",
        description: "Moderate the live feed, send announcements, and manage sponsored messages.",
      }
    }

    if (pathname.startsWith("/dashboard/events/")) {
      return {
        title: "Event Workspace",
        description: "Inspect event setup and performance detail.",
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
    <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur-xl transition-[width,height] ease-linear">
      <div className="flex h-(--header-height) w-full items-center gap-3 px-4 lg:px-6">
        <SidebarTrigger className="-ml-1 rounded-full" />
        <Separator
          orientation="vertical"
          className="data-[orientation=vertical]:h-5"
        />

        {/*
          The title and the description used to be the other way round: the
          page name rendered as a 0.68rem uppercase eyebrow and the description
          sentence was the <h1>. That put the wrong string in the document's
          only landmark heading and buried the one word telling you where you
          are.
        */}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-semibold text-foreground">{content.title}</h1>
          <p className="truncate text-xs leading-5 text-muted-foreground">
            {content.description}
          </p>
        </div>

        <div className="hidden items-center gap-3 md:flex">
          <div className="rounded-full border border-border bg-muted px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            {session?.user?.role ? roleLabels[session.user.role] ?? session.user.role : "Workspace"}
          </div>
          <div className="rounded-full border border-border bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground">
            {today}
          </div>
          <BrandLogo size="header" className="hidden xl:flex shrink-0" />
        </div>
      </div>
    </header>
  )
}
