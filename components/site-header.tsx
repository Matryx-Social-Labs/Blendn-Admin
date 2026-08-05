"use client"

import { useMemo } from "react"
import { usePathname } from "next/navigation"
import { useSession } from "next-auth/react"

import { NavUser } from "@/components/nav-user"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"

const routeContent: Record<string, { title: string; description: string }> = {
  "/dashboard": {
    title: "Overview",
    description: "Live reporting across growth, attendance, and event activity.",
  },
  "/dashboard/moderation": {
    title: "Moderation",
    description: "Flags and reports across the platform, oldest first.",
  },
  "/dashboard/events": {
    title: "Events",
    description: "Every event on the platform — search, filter, and drill in.",
  },
  "/dashboard/attendees": {
    title: "Attendees",
    description: "Who comes back, and who RSVPs but doesn't show.",
  },
  "/dashboard/venues": {
    title: "My venues",
    description: "Utilisation, ratings and bookings — one section per venue.",
  },
  "/dashboard/chatrooms": {
    title: "Chatrooms",
    description: "Every room whose chat is open — live events and post-event feedback windows.",
  },
  "/dashboard/users": {
    title: "Users",
    description: "Accounts, onboarding, and reachability.",
  },
  "/dashboard/organisers": {
    title: "Organisers",
    description: "The supply side: who publishes, and how concentrated it is.",
  },
  "/dashboard/venue-owners": {
    title: "Venues",
    description: "Every venue record — who owns each, which are unclaimed, and open disputes.",
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

  const role = session?.user?.role

  const content = useMemo(() => {
    // The overview says something different per role, as the design does — the
    // three dashboards answer different questions and a shared subtitle would
    // describe none of them.
    if (pathname === "/dashboard") {
      return {
        title: "Overview",
        description:
          role === "app_admin"
            ? "Platform health: what needs attention, growth vs vanity, and supply."
            : role === "organizer"
              ? "Your next event first — pacing, then what your past events say."
              : "Each venue on its own terms — utilisation, ratings, bookings.",
      }
    }

    const exact = routeContent[pathname]
    if (exact) return exact

    if (pathname.startsWith("/dashboard/events/") && pathname.endsWith("/messaging")) {
      return {
        title: "Chatrooms",
        description: "Every room whose chat is open — live events and post-event feedback windows.",
      }
    }

    if (pathname.startsWith("/dashboard/events/")) {
      return {
        title: "Event Workspace",
        description: "Inspect event setup and performance detail.",
      }
    }

    return routeContent["/dashboard"]
  }, [pathname, role])

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
        </div>

        {/* Account and sign-out live top-right, as the design places them. The
            sidebar footer previously carried this, which put the way *out* of
            the product at the far end of the way *around* it. */}
        <NavUser
          user={{
            name: session?.user?.name ?? "Blend'n",
            email: session?.user?.email ?? "",
            avatar: session?.user?.image ?? "",
            role: session?.user?.role,
          }}
        />
      </div>
    </header>
  )
}
