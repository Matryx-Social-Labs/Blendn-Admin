# Blend'n dashboard — design brief

Paste this into Claude Design. It covers every screen that needs designing, the
three that are structurally wrong today, and the cross-cutting behaviour
(sorting, filtering, bulk actions, chart exploration) that every data surface
needs and none currently has.

---

## The product

**Blend'n** is an event networking app in India. Attendees discover events, check
in with GPS, and talk in a pseudonymous event chatroom that closes 24 hours after
the event ends. This brief is for the **web dashboard**, which is a different
product from the mobile app and serves three roles.

The dashboard is an **operations console**, not a marketing site. The people
using it are working: an organiser checking whether tonight will fill, a venue
owner deciding whether to keep hosting a promoter, a platform admin clearing a
moderation queue before it ages out. Every screen should answer a question
someone actually has, at the moment they have it.

### The one thing to remember

**"This is serious operational software that happens to be beautiful."**

Not a dashboard template with a logo dropped in. The visual quality should make a
venue owner in Bangalore trust it with their bookings.

### The three roles

Authorization resolves on **organisation membership**, not on individual
identity. A host is a *company* — Byg Brewski, not one person's login — with
members at `owner` / `admin` / `staff`. This matters for design: screens say
"your organisation", colleagues see each other's work, and a venue survives one
person leaving.

| Role | Who they are | The question they open the dashboard to answer |
|---|---|---|
| `app_admin` | Blend'n staff | What needs my attention right now, across the whole platform? |
| `organizer` | A company that runs events | Will my next event fill, and what did my last ones teach me? |
| `venue_owner` | A company that owns venues | Is my room earning, and who is worth hosting again? |

`attendee` is **mobile-only** and never sees the dashboard.

A venue owner is not a lesser organiser. They get operational control (chat,
moderation, attendee list) over events at their venue that *someone else* runs,
but no editorial control — they cannot edit another company's event. When they
run their own event, they get both.

---

## What already exists

18 routes, all built and deployed:

```
/dashboard                     overview, different per role
/dashboard/events              list + /new, /[id], /[id]/feedback, /[id]/messaging
/dashboard/chatrooms           rooms with an open chat window
/dashboard/moderation          platform-wide flag queue (admin)
/dashboard/attendees           repeat attendance, no-show rate (organiser)
/dashboard/venues              per-venue sections (venue owner)
/dashboard/users               accounts (admin)
/dashboard/organisers          supply concentration (admin) + /[id]
/dashboard/venue-owners        venue records (admin) + /[id]
/dashboard/onboarding          host application queue (admin)
/dashboard/organisations       every host org (admin)
/dashboard/organisation        your own org: members, invites, domain (host)
```

Public: `/login`, `/apply`, `/apply/verify`, `/invite`.

---

## PART 1 — Three things that are structurally wrong

### 1.1 The top bar is a sidebar component wearing a header's clothes

`components/site-header.tsx` renders `<NavUser>` inside a horizontal `<header>`.
`NavUser` is built from `SidebarMenu` / `SidebarMenuItem` / `SidebarMenuButton`
with `size="lg"`, `h-auto px-3 py-3`, and a **three-line** name / email / role
stack. It was designed for a 288px sidebar footer. In a header row it is an
oversized block that fights everything beside it.

Also in that header, competing for the same space:

- a **role pill** (`APP ADMIN`)
- a **static date pill** showing today's date — not a control, not a filter, not
  interactive at all, and computed with `new Date()` during client render, which
  risks a hydration mismatch
- the NavUser block, which **shows the role again**

Counting the sidebar's own role label and the dropdown's, the user's role appears
**four times on one screen**. The date chip is pure decoration.

One more real bug: the dropdown opens with `side="right"` on desktop — it flies
off the right edge of the screen, because the trigger is already pinned there.

**Design the top bar properly.** Requirements:

- Page title (the single `h1`) and a one-line description, left, after the
  sidebar toggle
- **A real date-range control** where the decorative date chip is now — this is
  the global time window every chart and table on the page respects (see §3).
  Presets: Today, 7d, 30d, 90d, Custom. It should look like a control, because it
  is one.
- Account: a **compact** avatar-plus-chevron trigger sized for a header row, ~40px
  tall, not a three-line block. Name and email belong *inside* the dropdown, not
  on the bar.
- Dropdown opens **down and left-aligned to the right edge**
- Role appears **once** in the whole layout. Recommend keeping it in the sidebar
  under the logo and removing it from the header entirely.
- Sign out is in the dropdown, clearly separated, never a bare icon

Show the collapsed-sidebar state too. The sidebar collapses and the header must
not reflow badly when it does.

### 1.2 No table can be sorted, selected, or paged

`components/dashboard/data-table.tsx` is *the* shared table — used by attendees,
moderation, and all three overviews. It renders rows. That is all it does. No
sorting, no selection, no pagination; `toolbar` and `footer` are empty slots
waiting for something to be put in them.

Only `components/events-table.tsx` sorts. `@tanstack/react-table` is already a
dependency, so the capability is paid for and unused.

**Design one table system that every data surface uses.** It needs:

- **Sortable column headers** — click to sort ascending, click again for
  descending, click a third time to clear. The current state must be visible at a
  glance, not just an arrow that appears on hover. Show all three states.
- **Date columns sort chronologically**, never as strings, and the header should
  make the direction meaningful — "Newest first" reads better than a bare arrow
  on a date column.
- **Multi-select** — a checkbox column, a header checkbox for select-all-on-page,
  and a distinct "select all N matching" affordance when a filter is active.
  Selecting rows on page 1 and moving to page 2 must not silently discard the
  selection; show what is held.
- **A bulk action bar** that appears when rows are selected, states the count
  ("12 events selected"), and offers the actions valid for that selection.
  Destructive actions need a confirm step that names what will happen.
- **Filters in the toolbar** — a search field, plus per-column filters (status,
  role, category, date range) shown as removable chips so the active filter set is
  always legible. A "Clear all" when more than one is active.
- **Pagination** — page size selector, current range ("41–60 of 312"), and
  keyboard-navigable controls.
- **Column visibility** — a menu to hide columns, because admin tables get wide.
- **Empty, loading, and error states.** Empty is the *common* case here — this
  product has ~44 users — so an empty table must say what will fill it, not render
  a bare grid that looks broken.
- **Row density toggle** (comfortable / compact) for the admin tables.

Design the mobile behaviour explicitly. A 9-column table cannot become 9 stacked
labels; decide what collapses and what survives.

### 1.3 Charts are pictures, not instruments

`components/dashboard/charts.tsx` exports six charts — `PacingChart`, `Funnel`,
`TrendArea`, `UtilHeatmap`, `ArrivalCurve`, `CategoryBars`. Every one is
hover-tooltip-only. You cannot click anything, change the window, zoom, or
isolate a series.

**Make them explorable, the way Grafana and Kibana are.** Specifically:

- **Click-through to rows.** Clicking a bar, a slice, a funnel stage, or a
  heatmap cell filters the table below it to exactly that subset, and the applied
  filter appears as a removable chip. This is the single most valuable change: it
  turns "check-ins dropped on Tuesday" into "here are the eleven Tuesday events".
- **Brush-to-zoom on time series.** Drag across a region to narrow the window.
  Show the zoomed state and the "reset zoom" affordance.
- **The global date range** in the header drives every chart on the page, and a
  brush selection updates it, so charts and tables never disagree about what
  period is on screen.
- **Legend toggles series.** Click a series name to hide it; the axis rescales.
- **Compare to previous period** — a toggle that overlays the prior window as a
  faint line, with the delta stated numerically. "Is this good?" is unanswerable
  from one line.
- **Crosshair with a shared tooltip** across stacked charts, so reading two
  charts at the same instant does not require guessing.
- **Drill-down breadcrumbs.** Month → week → day, with a visible trail back out.
- **An export affordance per chart** — PNG for the chart, CSV for its data.

Keep the three honesty rules that already govern these charts, they are not
negotiable:

1. **Axes start at zero.** A truncated axis turns a 3% move into a cliff.
2. **Zero draws as zero.** An empty funnel stage renders as nothing, not as a
   sliver. Non-zero values get a 2% floor so a genuine 1-in-50,000 stays visible.
3. **Empty states say what will fill them.**

And one structural rule: **funnel stages must be nested subsets**, each filtering
the one above. An earlier version drew four independent populations as a funnel
and it widened downward.

---

## PART 2 — Screens that do not exist yet

Ordered by how much their absence hurts.

### 2.1 Account settings — `/dashboard/settings`

**There is no settings page at all.** The approval email we send to every new
host says *"Change the password after your first sign-in."* There is nowhere to
do that. We generate a password, send it in plaintext, and provide no way to
rotate it.

Design:
- **Profile** — name, avatar, email (with the change-email verification flow)
- **Password** — current, new, confirm, with strength feedback and a clear success
  state. This is the highest-priority missing screen.
- **Sessions** — active sessions with device and last-seen, and "sign out
  everywhere"
- **Notification preferences** — which emails this person receives
- For hosts: a link through to their organisation settings

### 2.2 Reports and export — `/dashboard/reports`

**The login page promises this and it does not exist.** Verbatim, on the sign-in
screen: *"Exportable reporting — Download platform, organiser, and venue reports
directly from the dashboard."* Nothing in the product exports anything. Either
build it or the login page is lying to every visitor.

Design:
- A report builder: pick a report type, a date range, and columns
- Preview before download
- CSV and PDF
- Scheduled reports emailed on a cadence (weekly ops summary)
- Per role: platform reports for admin, event/attendee reports for organisers,
  venue utilisation for venue owners

### 2.3 Audit log viewer — `/dashboard/audit`

`audit_logs` is written by **every** sensitive action — role changes,
suspensions, moderation decisions, invite domain-overrides, org approvals — and
**nothing ever reads it back**. Accountability data nobody can see is not
accountability.

Design a filterable timeline: who, what, when, to which resource, with the
`details` JSON expandable. Filters for actor, action type, resource, date range.
This is admin-only, and it is also where an org owner should be able to see what
their own members did (scoped to their org).

### 2.4 Event edit — `/dashboard/events/[id]/edit`

`EventEditor` already accepts an `initialEvent` prop, so it was built for
editing. **No route wires it up.** An event can be created and never changed.

Also: `/dashboard/events/new` **redirects `venue_owner` away**. A venue owner
running their own event is a case the permission model explicitly supports
(`eventPermissions` grants them both buckets there) and the UI forbids. Fix.

While redesigning the editor, two things have drifted:
- **Venue is still free text.** There is now a real `venues` table with owners,
  and the editor never sets `venue_id` — so an event at a claimed venue does not
  link to it, and the venue owner does not see it. Needs a venue picker with
  autocomplete over existing venues, plus "add a new venue" inline.
- **Categories are two-level now** (parent → child, e.g. Sports → IPL
  Streaming), and the editor renders a **flat list**. Needs grouped selection,
  with a designated primary category.

Design the editor as a **staged flow** — Basics → Location & Venue → Schedule →
Categories & Discovery → Capacity & Check-in → Media → Review — with a persistent
"save draft" and a preview of how the event will look in the mobile app.

### 2.5 Announcements and push — `/dashboard/events/[id]/announce`

`event_announcements` and `push_tokens` exist as tables, `canSendPushNotifications`
exists in the permission layer, and there is no UI. Broadcasting to every attendee
is the most powerful and most abusable thing a host can do — the design should
make the blast radius obvious *before* sending. Show the recipient count, a
preview of the push as it appears on a phone, and a confirm step. Rate limits are
already enforced server-side (3/min); surface them rather than letting a send
fail mysteriously.

### 2.6 Venue detail — `/dashboard/venues/[id]`

`/dashboard/venues` lists venues with per-venue sections but there is no
drill-down. A venue owner with eight rooms needs one page per room: utilisation
over time, the events hosted there, rating distribution, repeat organisers, and
the claim status.

Admin needs the same page plus: who owns it, unclaimed venues, and **claim
disputes** (two orgs claiming one venue) with a resolution flow.

### 2.7 Request to join an organisation

`/dashboard/organisation` currently shows a dead end for a user with no org:
"Contact support — this shouldn't happen." But there IS a `organisation_join_requests`
table and an approval flow built on the org side. The **requester's** half of that
flow has no UI. Someone whose email is on a verified domain should be able to find
their company and ask to join.

### 2.8 Category management — `/dashboard/categories`

Categories are seeded by a script (`scripts/seed-categories.ts`). Admin cannot
create, rename, reorder, or merge them. Two-level taxonomy, drag-to-reorder,
merge-with-reassignment, and a usage count per category so dead ones are visible.

### 2.9 Global search

No search of any kind. An admin looking for one event among hundreds has to
guess which list it is in. Command-palette style (⌘K), searching across events,
users, organisations and venues, grouped by type.

---

## PART 3 — Cross-cutting behaviour

These apply to **every** screen; design them once as a system.

1. **The header date range is global.** Every chart and table on a page respects
   it. Show where it lives, how a chart brush updates it, and how a page with no
   time dimension handles it.
2. **Filters are legible and removable.** Never a hidden filter that makes a
   number wrong with no visible cause. Chips, always.
3. **Loading states are skeletons that match the shape of the real content**,
   not spinners.
4. **Empty states name what will fill them.** This product is genuinely empty at
   ~44 users; empty is the common case, and it should never look broken.
5. **Errors are recoverable and specific.** "Couldn't load attendees — retry" not
   "Something went wrong."
6. **Destructive actions confirm and say exactly what happens.** Suspending an
   org, removing a member, deleting an event: name the consequence and whether it
   is reversible.
7. **Optimistic updates with rollback** on the fast actions (sort, filter,
   select). Never a full-page reload for a sort.
8. **Keyboard**: ⌘K search, arrow navigation in tables, Escape closes overlays.
9. **Accessibility**: visible focus rings, ARIA on sortable headers and
   selection, 4.5:1 contrast for body text, no colour-only status encoding.

---

## PART 4 — Transactional email (HTML)

Five emails send as **plain text** today. They need designed HTML, keeping a
plain-text alternative for clients that want it.

| Email | Trigger | Carries |
|---|---|---|
| **Confirm your email** | someone applies at `/apply` | verification link, 24h expiry |
| **Application approved** | admin approves | **first-login password**, sign-in link |
| **Application declined** | admin declines | the reason, and an invitation to reply |
| **You've been invited** | org invites a colleague | invite link, 7d expiry, who invited them and to what org |
| **Verify your domain** | domain verification fallback | verification link to a role address |

Design constraints, which are not optional:

- **Table-based layout, inline CSS.** Outlook does not support flexbox or grid.
- **600px max width**, single column, mobile-safe
- **Dark-mode aware** — the brand is dark-first but many clients force light. It
  must be legible in both.
- **One clear call to action**, a real button (bulletproof, table-based), plus the
  raw URL below it as text because some clients strip links
- **Logo as a hosted PNG** with alt text; images are blocked by default in many
  clients, so the email must still make sense with images off
- **Stated expiry** on every link — a link that silently stops working generates a
  support ticket every time
- **An "if you weren't expecting this, ignore it" line** on the three that arrive
  unsolicited
- The **approved** email carries a plaintext password: design that block so it is
  obviously sensitive, easy to copy, and paired with "change this after your first
  sign-in" (which needs §2.1 to exist)

Also design a **plain footer**: the sending company, a physical address (required
for compliance), and an unsubscribe link for anything non-transactional.

---

## PART 5 — Brand and technical constraints

### Colour

Defined once in `app/globals.css` as CSS custom properties. No component holds a
raw hex.

| Token | Role | Value |
|---|---|---|
| `--primary` | Primary orange | `#F05423` |
| `--chart-3` | Brand purple | `#8F49AA` |
| `--chart-2` | Secondary rose | `#BE5C71` |
| `--background` | Ink | `#0D0C0C` |
| `--foreground` | White | `#FFFFFF` |

`--chart-1 → 2 → 3` walks orange → rose → purple, so any series is on brand and a
gradient across all three is *the* brand gradient.

Three deliberate departures from the brand guideline, all keep-as-is:
- **Text on orange is ink, not white.** White on `#F05423` is 3.4:1 and fails
  WCAG AA; ink is 6.2:1.
- **Destructive is cooler and darker than brand orange**, or a down-trend badge
  beside a primary button reads as "the same colour, slightly wrong".
- **Success is a green from outside the palette.** The guideline defines no status
  colours; brand orange for "up" is indistinguishable from destructive.

### Type

**Satoshi**, self-hosted. Published weights are 300/400/500/700/900 — **there is
no 600**. `font-semibold` resolves up to 700, which is a real face. Do not design
against a weight that does not exist.

### Layout

- **Dark-first.** `app/layout.tsx` pins `.dark`. No theme toggle.
- **Container queries, not viewport breakpoints.** Content sits in
  `@container/main`; grids use `@sm/main:` and `@5xl/main:`, never `md:` or `xl:`.
  The sidebar is 288px and collapsible, so viewport width and content width differ
  by a large, changing amount — two grids on different systems visibly fall out of
  step when the sidebar collapses.
- **One `h1` per page**, owned by the header, holding the page *name*. Bodies
  start at `h2`.
- **Hierarchy from type, not boxes.** Exactly one hero metric per screen carries
  the brand gradient. If a second element wants it, the screen has two priorities
  and one is wrong. An earlier version put eleven things in identical bordered
  cards and nothing read as primary.
- **Icons outlined, never filled** (`@tabler/icons-react`, no `-Filled` variants).

### Stack

Next.js 16 App Router, React 19, Tailwind v4 (CSS-first `@theme`, no
`tailwind.config.js`), shadcn/ui, recharts 2, `@tanstack/react-table` 8.

Available shadcn primitives: avatar, badge, breadcrumb, button, calendar, card,
chart, checkbox, drawer, dropdown-menu, form, input, label, popover, progress,
radio-group, select, separator, sheet, sidebar, skeleton, slider, sonner, switch,
table, tabs, textarea, toggle, toggle-group, tooltip.

**No `dialog` component is installed** — confirmations currently use inline
expansion or `drawer`/`sheet`. If the design needs modals, say so and it will be
added.

---

## What to deliver

1. **The top bar**, fixed — expanded and collapsed sidebar, with the date-range
   control and a compact account menu
2. **The table system** — sorting states, selection, bulk action bar, filter
   chips, pagination, density, empty/loading/error, and the mobile collapse
3. **The chart system** — click-to-filter, brush-zoom, legend toggle,
   compare-to-previous, drill-down breadcrumbs
4. **Each new screen** in §2, desktop first, with the mobile view for anything a
   host would open on a phone
5. **The five emails**, HTML, light and dark
6. **A component sheet** of anything new, so it can be built once and reused

Desktop is primary — this is operational software used at a desk. But an
organiser *will* check pacing from their phone an hour before doors, so the
overview and the live event screen must work small.
