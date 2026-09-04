"use client"

import { Suspense, useMemo } from "react"
import { usePathname } from "next/navigation"
import { useSession } from "next-auth/react"

import { AccountMenu } from "@/components/account-menu"
import { CommandPalette, CommandPaletteTrigger } from "@/components/command-palette"
import { DateRangeControl } from "@/components/date-range-control"
import { SidebarTrigger } from "@/components/ui/sidebar"

/**
 * The top bar.
 *
 * Left: the sidebar toggle, then the page's single `h1` and a one-line
 * description. Right: the global date range, then a compact account menu.
 *
 * Three things were removed rather than restyled:
 *
 *   - a **role pill**, because the role already appears in the sidebar. Between
 *     the sidebar, that pill, the account trigger and the account menu, the
 *     role was on screen four times.
 *   - a **date chip** showing today's date. It was not a control, not a filter,
 *     and computed with `new Date()` during client render — a hydration
 *     mismatch waiting to happen. A real date-range control occupies that space
 *     now, and every chart and table on the page reads it.
 *   - `NavUser`, a `SidebarMenu` component built for the 288px sidebar footer,
 *     which rendered a three-line block inside a horizontal header.
 */

/** Pages whose content has no time dimension hide the range control. */
const TIMELESS = new Set([
  "/dashboard/settings",
  "/dashboard/organisation",
  "/dashboard/organisations",
  "/dashboard/onboarding",
  "/dashboard/categories",
  "/dashboard/amenities",
  "/dashboard/events/new",
  // A brand is four fields about a company. A date-range control over it would
  // be a filter with nothing to filter.
  "/dashboard/brand",
  "/dashboard/sponsors",
  "/dashboard/sponsor-claims",
  "/dashboard/creative-review",
  "/dashboard/charges",
  // Two queues, not two reports. Curation health is "everything we ever added,
  // and which of it is dead"; the claim queue is oldest-first by design. A
  // range control over either would offer to hide the rows most worth seeing.
  "/dashboard/events/curate",
  "/dashboard/claims",
  "/dashboard/claims/venues",
  "/dashboard/venues/new",
])

/** Reports read the range, so the control stays. */

const routeContent: Record<string, { title: string; description: string }> = {
  "/dashboard/moderation": {
    title: "Moderation",
    description: "Flags and reports across the platform, oldest first.",
  },
  "/dashboard/events": {
    title: "Events",
    description: "Every event on the platform — search, filter, and drill in.",
  },
  "/dashboard/events/new": {
    title: "New event",
    description: "Publish an event. Save a draft at any point.",
  },
  /*
   * Both of these need an exact entry, and the reason is the fallback below.
   *
   * `/dashboard/events/curate` matches `startsWith("/dashboard/events/")`, so
   * without this it inherited the event *detail* header — the curation screen
   * announced itself as "Event · Setup, performance, and what happened on the
   * night." `/dashboard/claims` matched nothing and fell to the generic
   * "Overview · Live reporting across growth, attendance, and event activity."
   *
   * Both pages carry an `h2` and a comment saying this file owns their only
   * `h1`, which is what made it invisible: the screens looked right, and the
   * one element a screen reader announces first named a different screen.
   */
  "/dashboard/events/curate": {
    title: "Curation",
    description: "Events we added from public listings — and which of them nobody could get into.",
  },
  "/dashboard/claims": {
    title: "Claims",
    description: "Somebody wants ownership of an event or a venue. Decide, oldest first.",
  },
  /*
   * Four more the guard found once it existed, three of them older than this
   * screen. `/dashboard/leads` and `/dashboard/venues/new` were the worst of
   * them: both render their own `h1`, so the page had *two* — a correct one in
   * the body and "Overview" above it.
   */
  "/dashboard/claims/venues": {
    title: "Claims",
    description: "Somebody wants ownership of an event or a venue. Decide, oldest first.",
  },
  "/dashboard/moderation/reports": {
    title: "Reports",
    description: "What people reported about each other, and what was decided.",
  },
  "/dashboard/venues/new": {
    title: "Add a venue",
    description: "A permanent place. Events attach to it; its pin is the one they inherit.",
  },
  "/dashboard/attendees": {
    title: "Attendees",
    description: "Who comes back, and who RSVPs but doesn't show.",
  },
  /*
   * "Venues", not "My venues": this route now serves two roles. An owner sees
   * their utilisation view and an admin sees the record index, and the h1
   * cannot say "my" to the one who owns none of them.
   *
   * The role-specific wording lives in `dashboard-nav.ts` instead, which is
   * already filtered per role — so an owner still reads "My venues" in the
   * sidebar, where saying it is both true and useful.
   */
  "/dashboard/venues": {
    title: "Venues",
    description: "Who owns each, and what runs there.",
  },
  // Pre-existing gaps, found by __tests__/nav-routes-exist.test.ts: both had
  // nav entries and no title, so both rendered with the document's only h1
  // reading "Overview". Copy taken verbatim from lib/dashboard-nav.ts so the
  // sidebar and the heading cannot describe the same screen differently.
  "/dashboard/leads": {
    title: "Leads",
    description: "Demo requests from the organiser landing page. Oldest untouched first.",
  },
  "/dashboard/venue-claims": {
    title: "Venue claims",
    description:
      "Ownership requests. Approving one hands over the events other organisers hold there.",
  },
  "/dashboard/charges": {
    title: "Charges",
    description: "What each placement costs, what has been agreed, and what has been paid.",
  },
  "/dashboard/creative-review": {
    title: "Creative review",
    description: "Sponsored copy waiting to be read by a person. Oldest first.",
  },
  "/dashboard/sponsors": {
    title: "Brands",
    description: "Every brand — who owns each, which are unclaimed, and possible duplicates.",
  },
  "/dashboard/sponsor-claims": {
    title: "Brand claims",
    description: "Ownership requests. Approving one hands over a brand's name and its reporting.",
  },
  "/dashboard/placements": {
    title: "Placements",
    description: "Where your brand appears, and what is waiting on you.",
  },
  "/dashboard/brand": {
    title: "Brand",
    description: "Your name, logo and website, as attendees see them.",
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
  /*
   * "Venue owners", not "Venues" — accounts, not records.
   *
   * This route rendered an h1 reading "Venues" over a list of *people*, and
   * described itself as "every venue record", which is the screen that did not
   * exist until `/dashboard/venues` grew an admin index. Two routes then shared
   * one heading and neither matched its contents.
   */
  "/dashboard/venue-owners": {
    title: "Venue owners",
    description: "The people who run venues — accounts, not the venue records.",
  },
  "/dashboard/onboarding": {
    title: "Applications",
    description: "Host applications awaiting review. Every one is read by a person.",
  },
  "/dashboard/organisations": {
    title: "Organisations",
    description: "Every host on the platform — members, domains, and suspension.",
  },
  "/dashboard/organisation": {
    title: "Your organisation",
    description: "Colleagues, invites, and domain verification.",
  },
  "/dashboard/categories": {
    title: "Categories",
    description: "The two-level taxonomy events are filtered by on the app.",
  },
  "/dashboard/amenities": {
    title: "Amenities",
    description:
      "What an event offers. Retiring one stops it being offered for new events without rewriting the ones that already list it.",
  },
  "/dashboard/reports": {
    title: "Reports",
    description: "Download events, attendance, ratings and moderation as CSV.",
  },
  "/dashboard/audit": {
    title: "Audit log",
    description: "Who did what, when. Written automatically and never editable.",
  },
  "/dashboard/settings": {
    title: "Settings",
    description: "Your account, password, and what we email you about.",
  },
}

export function SiteHeader() {
  const pathname = usePathname()
  const { data: session } = useSession()
  const role = session?.user?.role

  const content = useMemo(() => {
    // The overview asks a different question per role, as the design does — the
    // three dashboards are genuinely different screens and a shared subtitle
    // would describe none of them.
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
    if (pathname.startsWith("/dashboard/events/") && pathname.endsWith("/edit")) {
      return { title: "Edit event", description: "Changes go live as soon as you save." }
    }
    if (pathname.startsWith("/dashboard/events/")) {
      return { title: "Event", description: "Setup, performance, and what happened on the night." }
    }

    return {
      title: "Overview",
      description: "Live reporting across growth, attendance, and event activity.",
    }
  }, [pathname, role])

  const showRange = !TIMELESS.has(pathname) && !pathname.endsWith("/edit")

  return (
    <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur-xl transition-[width,height] ease-linear">
      <div className="flex min-h-14 w-full items-center gap-3.5 px-4 py-2 lg:px-6">
        <SidebarTrigger className="-ml-1 size-[34px] shrink-0 rounded-lg border border-border" />

        {/*
          The single `h1` on the page, holding the page *name*. It used to be
          the description sentence, which put the wrong string in the document's
          only landmark heading.
        */}
        <div className="flex min-w-0 flex-1 flex-col gap-px">
          <h1 className="truncate text-[1.25rem] font-bold leading-[1.25]">{content.title}</h1>
          <p className="truncate text-[0.78125rem] text-muted-foreground">{content.description}</p>
        </div>

        <CommandPalette />
        <CommandPaletteTrigger className="hidden @2xl/main:inline-flex" />

        {showRange ? (
          // useSearchParams needs a Suspense boundary or the whole route opts
          // out of static rendering and the build warns.
          <Suspense fallback={<div className="hidden h-9 w-[250px] @3xl/main:block" />}>
            <DateRangeControl className="hidden @3xl/main:inline-flex" />
          </Suspense>
        ) : null}

        <AccountMenu
          name={session?.user?.name ?? "Blend'n"}
          email={session?.user?.email ?? ""}
          image={session?.user?.image}
          showOrganisation={role === "organizer" || role === "venue_owner"}
        />
      </div>
    </header>
  )
}
