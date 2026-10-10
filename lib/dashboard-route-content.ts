/**
 * What every dashboard route is called, and where it sits.
 *
 * One map feeds two things: the page's only `h1` (the in-content `PageHeader`,
 * R5) and the top bar's breadcrumbs. They used to be one thing — the header
 * showed the title — and keeping them on one source is what stops a page from
 * being called one thing in the crumbs and another in its heading.
 *
 * Pure, with no React and no session, so the guards can import it rather than
 * read it with a regex.
 */
export interface RouteContent {
  title: string
  description: string
}

export const routeContent: Record<string, RouteContent> = {
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
   * without this it inherited the event *detail* heading — the curation screen
   * announced itself as "Event · Setup, performance, and what happened on the
   * night." `/dashboard/claims` matched nothing and fell to the generic
   * "Overview · Live reporting across growth, attendance, and event activity."
   */
  "/dashboard/events/curate": {
    title: "Curation",
    description: "Events we added from public listings — and which of them nobody could get into.",
  },
  "/dashboard/claims": {
    title: "Claims",
    description: "Somebody wants ownership of an event or a venue. Decide, oldest first.",
  },
  "/dashboard/claims/venues": {
    title: "Claims",
    description: "Somebody wants ownership of an event, a venue or a brand. Decide, oldest first.",
  },
  "/dashboard/claims/brands": {
    title: "Claims",
    description: "Somebody wants ownership of an event, a venue or a brand. Decide, oldest first.",
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
    description: "Who comes back, who doesn't show. Labels only, never names.",
  },
  /*
   * "Venues", not "My venues": this route serves two roles. An owner sees their
   * utilisation view and an admin sees the record index, and the h1 cannot say
   * "my" to the one who owns none of them. The sidebar, already filtered per
   * role, says "My venues" to the owner.
   */
  "/dashboard/venues": {
    title: "Venues",
    description: "Who owns each, and what runs there.",
  },
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
  // Accounts, not records: "Venues" over a list of people named neither.
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
  // "Team", as the sidebar calls it for every host role (the kit's name).
  "/dashboard/organisation": {
    title: "Team",
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
  "/dashboard/analytics": {
    title: "Analytics",
    description: "Which nights worked, and whether the people who came once came back.",
  },
  "/dashboard/plan": {
    title: "Plan",
    description: "Running events on Blend'n is free. Analytics is for knowing which nights worked, and why.",
  },
  "/dashboard/settings": {
    title: "Settings",
    description: "Your account, password, and where you are signed in.",
  },
}

/**
 * The page's name and its one sentence.
 *
 * An exact entry wins; dynamic routes (`[id]`) fall to the prefix rules; and
 * anything else is called "Overview" — deliberately generic, so a static route
 * that forgot its entry is visibly wrong and `dashboard-header-title.test.ts`
 * catches it, rather than getting a plausible title derived from its path.
 */
export function routeHeading(pathname: string, role: string | undefined): RouteContent {
  // The overview asks a different question per role: the four overviews are
  // genuinely different screens and a shared sentence would describe none.
  if (pathname === "/dashboard") {
    return {
      title: "Overview",
      description:
        role === "app_admin"
          ? "What is waiting on you, whether the loop closes, and who is supplying it."
          : role === "organizer"
            ? "What is live, whether the next event is filling, and what is left to set up."
            : role === "sponsor"
              ? "What is running, what is waiting on you, and who your sends reached."
              : "Each venue on its own terms — utilisation, ratings, bookings.",
    }
  }

  // The events list is scoped by role, and "every event on the platform" was
  // read by a venue owner above a list of fourteen at theirs.
  if (pathname === "/dashboard/events" && role !== "app_admin") {
    return {
      title: "Events",
      description:
        role === "venue_owner"
          ? "Every event at your venues. Open one for its live view and its room."
          : "Everything your organisation runs. Open one for its live view, attendees, room and feedback.",
    }
  }

  // A venue's plan is the venue's, not an organiser's Analytics (step 17).
  if (pathname === "/dashboard/plan" && role === "venue_owner") {
    return {
      title: "Plan",
      description: "Listing your venue is free. Venue Pro is a year of insight, and its history from before your claim.",
    }
  }

  const exact = routeContent[pathname]
  if (exact) return exact

  if (pathname.startsWith("/dashboard/events/") && pathname.endsWith("/messaging")) {
    return { title: "Room chat", description: "What is being said, and what needs you." }
  }
  if (pathname.startsWith("/dashboard/events/") && pathname.endsWith("/edit")) {
    return { title: "Edit event", description: "Changes go live as soon as you save." }
  }
  if (pathname.startsWith("/dashboard/events/") && pathname.endsWith("/feedback")) {
    return { title: "Feedback", description: "What the people who came said afterwards." }
  }
  if (pathname.startsWith("/dashboard/events/")) {
    return { title: "Event", description: "Setup, performance, and what happened on the night." }
  }
  if (pathname.startsWith("/dashboard/organisers/")) {
    return { title: "Organiser", description: "One host account and the events it created." }
  }
  if (pathname.startsWith("/dashboard/venue-owners/")) {
    return { title: "Venue owner", description: "One owner account and the events it created." }
  }
  if (pathname.startsWith("/dashboard/venues/") && pathname.endsWith("/claim")) {
    return {
      title: "Claim a venue",
      description: "Reviewed by an admin. Approval links every event held there to you.",
    }
  }
  if (pathname.startsWith("/dashboard/venues/")) {
    return {
      title: "Venue",
      description: "One building — who is in it now, who books it, and its record.",
    }
  }

  return {
    title: "Overview",
    description: "Live reporting across growth, attendance, and event activity.",
  }
}

/**
 * Routes whose page renders its own `PageHeader`, so the layout's steps aside.
 *
 * One record per route, and the layout cannot name it: an event's page is
 * called by the event's title, with the event's own actions beside it, and
 * only the page has loaded the event (and checked who may see it). The page
 * renders `<PageHeader>` server-side as its first child; `RoutePageHeader`
 * returns nothing here. `dashboard-header-title.test.ts` holds each side to
 * it: an owned route's page renders exactly one `PageHeader`, every other
 * route's none.
 *
 * The breadcrumbs keep the route's kind ("Events › Event › Room"): the top bar
 * is in the layout and cannot know the record's name without the page telling
 * it, and the heading below already says it.
 */
export const OWNED_HEADERS: RegExp[] = [
  /^\/dashboard\/events\/[^/]+$/,
  /^\/dashboard\/events\/[^/]+\/(edit|messaging|feedback)$/,
  /^\/dashboard\/venues\/[^/]+$/,
  /^\/dashboard\/venues\/[^/]+\/claim$/,
  /^\/dashboard\/organisers\/[^/]+$/,
  /^\/dashboard\/venue-owners\/[^/]+$/,
]

/** Static routes that share a dynamic route's shape and are NOT records. */
const NOT_A_RECORD = new Set(["/dashboard/events/new", "/dashboard/events/curate", "/dashboard/venues/new"])

export function ownsHeader(pathname: string): boolean {
  if (NOT_A_RECORD.has(pathname)) return false
  return OWNED_HEADERS.some((re) => re.test(pathname))
}

/**
 * The document `<title>` for a page the layout names: the same word as its
 * `h1` (WCAG 2.4.2), and the root layout's template appends the product.
 * Owned routes export `generateMetadata` with the record's name instead.
 */
export function routeMetadata(pathname: string): { title: string } {
  return { title: routeHeading(pathname, undefined).title }
}

export interface Crumb {
  label: string
  /** Absent on the last crumb, which is the page you are on. */
  href?: string
}

/**
 * The top bar's trail: the organisation, then each route above this one.
 *
 * Built from the same headings as the `h1`, one per path prefix, so
 * `/dashboard/events/<id>/messaging` reads "Org › Events › Event › Room". The
 * overview is the organisation crumb itself rather than a second "Overview"
 * after it. A prefix that names the same thing as the one before it is
 * skipped: `/dashboard/claims/venues` is one queue with tabs, not "Claims ›
 * Claims".
 */
export function breadcrumbsFor(pathname: string, role: string | undefined, org: string): Crumb[] {
  if (pathname === "/dashboard") return [{ label: org, href: "/dashboard" }, { label: "Overview" }]

  const crumbs: Crumb[] = [{ label: org, href: "/dashboard" }]
  const segments = pathname.split("/").filter(Boolean).slice(1)
  for (let i = 1; i <= segments.length; i++) {
    const href = "/dashboard/" + segments.slice(0, i).join("/")
    const { title } = routeHeading(href, role)
    // Compared from the second crumb on: an organisation that happens to be
    // called "Events" must not swallow the Events crumb after it.
    if (crumbs.length > 1 && crumbs[crumbs.length - 1].label === title) continue
    crumbs.push({ label: title, href })
  }
  // The page you are on is not a link to itself.
  const last = crumbs[crumbs.length - 1]
  crumbs[crumbs.length - 1] = { label: last.label }
  return crumbs
}

/**
 * The routes whose numbers change when the date range does.
 *
 * An allow-list, because the deny-list it replaced defaulted the wrong way and
 * put a five-button control on 19 routes that read no range at all.
 * `__tests__/range-control-scope.test.ts` fails the build when this list and
 * the pages that call `resolveRange` stop agreeing.
 */
export const RANGED = new Set(["/dashboard", "/dashboard/reports"])

/** `/dashboard/venues/<id>`, which scopes its event list to the range. */
export const RANGED_VENUE_DETAIL = /^\/dashboard\/venues\/[^/]+$/

export function showsRange(pathname: string, role?: string): boolean {
  /*
   * Only the admin's overview reads the range. The organiser, venue and sponsor
   * overviews are built on fixed windows ("Last 30 days"), and offered them a
   * 7d / 90d control that changed nothing (step 15).
   */
  if (pathname === "/dashboard" && role !== undefined && role !== "app_admin") return false
  return (
    RANGED.has(pathname) ||
    // `/dashboard/venues/new` matches the shape and is a form, not a report.
    (RANGED_VENUE_DETAIL.test(pathname) && pathname !== "/dashboard/venues/new")
  )
}
