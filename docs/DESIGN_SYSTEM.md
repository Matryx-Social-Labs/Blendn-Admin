# Design system

How the dashboard implements the Blend'n Brand Guideline. Source of truth for
colour, type, and the layout rules that are easy to break by accident.

## Owner rulings, 2026-10-01

The claude.ai/design "Blend'n Design System" organiser and platform kits are the
reference for every dashboard screen. They predate some product rules, so the
owner ruled on each conflict. These rulings are the rules now. Where a section
below used to say otherwise, it has been rewritten.

| # | Ruling | What it means on a screen |
|---|---|---|
| R1 | **Hosts see labels, never names** (SCRUM-383 b). | Organisers, venue owners and sponsors see an attendee as a pseudonymous label in mono plus counts. Never a name, email, phone, photo, avatar or profile, and never one person's live status ("In the room"). The kit's Name/Avatar columns and "Names only" copy are replaced with the label. Labels are salted with the event's organisation: stable across its events, the same for every member, different at every other organisation. **Every member of the organisation that runs the event (owner, admin and staff) sees the label roster**, because staff work the door and the room. A venue sees aggregates and never people (SCRUM-501). On another host's event at its venue, the Overview and Attendees tabs show Going, Came and fill by the same rule as the Events list, the venue page and the exports (`discloseVenueCounts`, through `venueCounts`). A count is held back under 5, when it would name everyone going or all but one, and when walk-ins take it past the going count. Any other count of people goes through `discloseHeadcount`. Zero is always shown. Hosts get arrivals to the quarter hour, in label order, and none at all while fewer than 5 came, because the room announces each check-in under a room pseudonym. `app_admin` keeps full details on `/dashboard/users`. Guarded by `__tests__/attendee-identity-boundary.test.ts`. The one exception is a regular who opts in to being visible to a venue (plan §2). |
| R2 | **No "Waved".** | A wave is a socket event with no row, so nothing can count it. Funnels run RSVP, then checked in, then chatted, then mutual yes. Never design a stage the schema cannot produce. |
| R3 | **Bordered panels.** | This replaces "hierarchy comes from type, not boxes". See *Panels* below. |
| R4 | **The plan-card stripe is allowed.** | One gradient element per screen, plus the sidebar plan card's `--gradient-brand` stripe, which is a brand constant on every screen. See *Gradients* below. |
| R5 | **The h1 lives in the content area.** | An in-content `PageHeader` (26px title, one sentence, actions on the right) owns the h1, and the top bar carries breadcrumbs. Moved in step 14. See *One `h1` per page*. |
| R6 | **Applications stay person-reviewed.** | No self-serve "Set up your organisation" straight into the dashboard. "Get started" is a nicer `/apply`, and event creation stays gated by `mayCreateEvents` (SCRUM-145). |
| R7 | **The crews switch on the event form lands with crews. Chat-at-doors stays out.** | The kit's "In the room" switches have no fields. Each one ships with its feature or not at all. "Room chat opens at doors" waits for the pre-event chat decision. |

Four more rules from the same review override the kit wherever it shows otherwise:

- **Paywall previews use sample data only.** A blurred `Locked` preview renders static sample figures and never the org's real numbers. CSS blur hides nothing from the RSC payload. A paid value is never computed for a caller who has not paid. A locked KPI tile omits its value.
- **Held-back states for floors.** A figure under its suppression floor shows a held-back state that says why, never a small number and never a blank. Distributions and counts use `MIN_CELL` 5 (`lib/disclosure.ts`). Connections use 8 (`MIN_ATTENDEES`, `lib/connection-metrics.ts`). The kit draws neither state, so each screen that shows these figures has to add it.
- **Team roles are owner, admin and staff.** The kit's Owner/Member labels are not used. The roles come from `prisma/schema.prisma` and `/dashboard/organisation`.
- **Ratings rows stay admin-only.** Hosts get rating distributions above the floor, and never a star attached to a single comment (SCRUM-437).

## Colour

Defined once in `app/globals.css` as CSS custom properties, consumed everywhere
through Tailwind tokens (`bg-primary`, `text-muted-foreground`, `var(--chart-1)`).
No component should contain a raw hex.

| Token | Guideline role | Value |
|---|---|---|
| `--primary` | Primary orange | `#F05423` |
| `--chart-3` / `--color-brand-purple` | Primary purple | `#8F49AA` |
| `--chart-2` / `--color-brand-rose` | Secondary rose | `#BE5C71` |
| `--background` (dark) | Secondary ink | `#0D0C0C` |
| `--foreground` (dark) | Secondary white | `#FFFFFF` |

### The purple is not the hex printed in the PDF

Page 6 of the guideline labels the purple swatch `#925D46`. That hex is a muted
brown. The swatch beside it renders `#8F49AA`, and the CMYK printed with it
(47/74/0/0) is also a purple. Two of the three agree, so the label is treated as
a transcription slip and `#8F49AA` is used.

The values in `globals.css` were sampled from a 150dpi render of the guideline's
own swatches rather than typed from the labels. **If the designer confirms a
different purple, it is one token to change.**

### Departures from the guideline, and why

The guideline covers brand colour. It does not define UI semantics, so three
tokens are decided here:

- **`--primary-foreground` is ink, not white.** White on `#F05423` is 3.4:1,
  which fails WCAG AA for body text; ink is 6.2:1. It also matches the
  guideline's own monogram-on-orange tile (page 5), which is dark on orange.
- **`--destructive` is pushed cooler and darker than brand orange.** A stock red
  sits about 14° of hue from `#F05423` and reads as "the same colour, slightly
  wrong" when a down-trend badge lands next to a primary button.
- **`--success` is outside the brand palette.** The guideline defines no status
  colours. Brand orange for "up" is indistinguishable from destructive, and rose
  is already a chart series, so a green is used. Use `text-success` for positive
  deltas — never `text-chart-1`, which is what the metric arrows used to do and
  which rendered a positive change in blue.
- **`--destructive-foreground` is ink in the dark theme, not the kit's white.**
  It labels the 11px nav badge. On the dark `--destructive`, measured through a
  canvas, white is 3.83:1, under the 4.5:1 floor, and ink is 5.1:1. The light theme keeps
  white (5.45:1 on its darker red). Before this token existed,
  `text-destructive-foreground` produced no CSS at all, and the badge count
  inherited the row's muted grey (1.53:1). `__tests__/theme-tokens.test.ts`
  now fails on any `*-foreground` utility with no `--color-*` token behind it.

### Tokens the design kit added (2026-10-01)

| Token | Value | Use |
|---|---|---|
| `--brand-ink` | `oklch(0.156 0.002 17.3)` (`#0D0C0C`) | The kit's `var(--brand-ink)`. `text-brand-ink` reads it, so the two are one value. |
| `--gradient-ember` | see *Gradients* | The interface gradient (ProTag, the organiser's chat bubble). |
| `--radius-panel` → `rounded-panel` | 12px | The Panel (R3). `--radius` stays 10px for tiles, tables and the hero. |
| `--text-page-title` → `text-page-title` | 26px | The in-content PageHeader title (R5). |
| `--text-panel-title` → `text-panel-title` | 15px | A Panel's title (`components/dashboard/kit.tsx`). `SectionTitle` is still 17px until the screens move to Panels (step 15). |

### Charts

`--chart-1` → `--chart-2` → `--chart-3` walk the primary gradient (orange →
rose → purple), so any series drawn in one of them is on brand, and a gradient
across all three is *the* brand gradient. `--chart-4` and `--chart-5` are
supporting hues for the rare case where three is not enough separation.

Chart hues are lifted in the dark theme: the brand purple at its true lightness
(L 0.532) does not carry against `#0D0C0C`.

## Typography

Satoshi, per page 7 of the guideline. Self-hosted from `app/fonts/` and wired in
`app/fonts.ts` — not loaded from Fontshare's CDN, so the first render does not
block on a third party. The ITF Free Font License permits self-hosting.

Fontshare publishes 300/400/500/700/900 and **no 600**. A lot of the UI uses
`font-semibold` (600), which CSS font matching resolves upward to the 700 face —
a real weight, not a synthesised one — so the gap costs nothing and saves a
25 kB download.

`--font-satoshi` feeds `--font-sans`, so `font-sans` and every unstyled element
inherits it with no per-component change.

## Icons

Outlined only, never filled (page 8). `@tabler/icons-react` is outline by
default; do not reach for `-Filled` variants.

## Theme

`app/layout.tsx` pins `.dark`. The guideline is dark-first — every page of it is
`#0D0C0C` — and there is no theme toggle. The `:root` (light) block is kept
brand-correct rather than left as stock shadcn grey, so flipping the theme later
does not ship an off-brand screen.

Surfaces above the background lift with a trace of brand purple rather than
neutral grey, so the greys read warm instead of dead.

## Layout rules

### Use container queries, not viewport breakpoints

The dashboard content sits inside `@container/main` (`app/dashboard/layout.tsx`).
Grids there must use `@sm/main:`, `@5xl/main:` and so on — **not** `md:` or
`xl:`.

This is not stylistic. The sidebar is 248px and collapsible, so viewport width
and content width differ by a large, changing amount. The KPI grid and the
spotlight grid directly below it once used different systems, and collapsing the
sidebar reflowed them at different widths — they visibly fell out of step.

### One `h1` per page

There is exactly one, and it holds the page *name*. Page bodies start at `h2`.
The header used to render the page name as a 0.68rem uppercase eyebrow with the
description sentence as the `h1`, which put the wrong string in the document's
only landmark heading.

**It lives in the content area (R5, step 14).** The layout renders
`RoutePageHeader` as the first thing in `<main>`. That renders `PageHeader`
(`components/dashboard/page-header.tsx`): a 26px title (`text-page-title`),
one sentence, and the page's actions on the right. The 60px top bar shows
breadcrumbs and no heading. The title, the sentence and every crumb come from
`routeContent` in `lib/dashboard-route-content.ts`, so the last crumb and the
`h1` are always the same word. `__tests__/dashboard-header-title.test.ts` holds
every static route to an entry there, and fails on an `h1` or a `<PageHeader>`
in any page or in the components it imports. `e2e/dashboard-shell.spec.ts`
counts the h1s in a browser for every role.

A page that needs its own header (an event's name, its QR and Edit actions)
cannot render one yet: the layout's would make two. Step 15 adds the way for a
page to stand the layout's header down.

### Panels: bordered, and still one priority per screen (R3)

This used to read "hierarchy comes from type, not boxes". The kit composes every
role's screens from bordered **Panels**, and the owner adopted them. A Panel has
the `--card` background, a 1px `--border`, `rounded-panel` (12px) and 20px of
padding. Its title is 15px bold (`text-panel-title`), with an optional faint hint
beside it.

The reason the old rule existed still holds. The old overview put eleven things
in bordered cards at identical visual weight, so nothing read as primary and the
eye had nowhere to land. So:

- **Exactly one `HeroMetric` per screen.** Panels group content. They do not rank
  it, and a screen whose panels all compete has two priorities, one of which is
  wrong.
- **No card inside a card.** A Panel holds rows, tiles and charts, never another
  bordered box.
- `MetricTile`s inside a Panel or a KPI strip carry no chrome of their own.

### Charts are honest by construction

Three rules, enforced in `components/dashboard/charts.tsx`:

1. **Axes start at zero.** A truncated axis turns a 3% move into a cliff.
2. **Zero draws as zero.** `barWidth` in `lib/dashboard-view.ts` returns 0 for a
   zero value; the previous inline version was `Math.max(10, …)`, which drew an
   empty funnel stage as if it had a tenth of the best stage's traffic. A
   non-zero value gets a 2% floor so one check-in out of fifty thousand stays
   visible — a rounding courtesy for values already above zero, not an invented
   one.
3. **Empty says what will fill it**, rather than rendering a bare grid that
   reads as a broken chart.
4. **No cumulative series.** A running total can only go up, so it cannot show
   the one thing a growth chart is for. The admin overview plotted cumulative
   signups against weekly actives for months; staging read 42, 42, 45, 82, 95,
   95, 95, 121 and drew three flat weeks as a plateau at the ceiling,
   indistinguishable from health. The chart is gone rather than rescaled — the
   honest version is a weekly series off `product_events`, and half of an
   honest chart is worse than none.
5. **A stage nobody reached is drawn full width, in outline.** `barWidth`
   correctly returns 0 for a zero, which made the three stages that carry the
   entire product thesis — matched, conversed, came back — the quietest marks
   on the screen. Outline at full width makes the absence as loud as the
   population above it, and it is a shape difference, so it survives greyscale.

**Funnel stages must be nested subsets.** The first implementation counted four
independent populations — onboarded profiles, users with an RSVP, users with a
check-in — and drew them as a funnel; staging had 7 onboarded and 10 RSVP'd, so
the funnel widened downward. Each stage now filters on the one above it. The
integration suite asserts the sequence is non-increasing.

## What each role sees

The redesign's central correction: the three roles get genuinely different
screens, and the forward-looking question comes before any trailing report.
Every figure on the old overview was a 30-day lookback, which answers "how did
we do" and never "what needs attention now".

| | app_admin | organizer | venue_owner |
|---|---|---|---|
| Leads with | attention strip: every queue, oldest breach first | next event's fill %, in 40px type | per-venue comparison table |
| Primary chart | the loop, seven stages | RSVP pacing vs capacity | utilisation heatmap, day x slot |
| Hero | people who came back for a second event | next event's fill % | — |
| Secondary | turn-up and refusals; supply concentration | rating distribution | rating distribution, busiest venue |
| Own screens | Moderation, Users, Organisers, Venues, Applications, Organisations | Attendees, My organisation | My venues, My organisation |

**Applications / Organisations vs My organisation.** Two screens, not one with a
branch. A platform admin managing every host and an owner managing their own
company want different things on screen, and the audit trail should record which
of the two acted — an admin acting through the host screen would be logged as
though the org's own owner did it. `app_admin` is redirected away from
`/dashboard/organisation`, and hosts never see the platform pair.

### The moderation queue is new

`moderation_flags` is a core table whose pending count is the most
time-sensitive number an admin has, and the only way to see any of it was to
open one event's messaging page at a time. `/dashboard/moderation` is
platform-wide, ordered oldest-first because **age is the SLA**, and every
decision writes to `audit_logs`.

The sidebar badge count is fetched in the server layout, not by a client
effect — an alert that pops in after paint is one the operator has already
scrolled past.

### Venues are modelled now

This section used to say venues were derived from a free-text string. That
stopped being true in v0.18.0: there is a real `venues` table with an owning
organisation, and `events.venue_id` links to it.

`events.venue_name` is **kept** and still free text, because most events are at
places that are not on the platform — `venue_id` is null for those, and the name
is all there is. Any screen showing venues has to handle both.

One thing has not caught up: `components/event-editor.tsx` never sets
`venue_id`, so an event created through the dashboard does not link to a claimed
venue and its owner never sees it. See `docs/CLAUDE_DESIGN_BRIEF.md` §2.4.

## Navigation and roles

`lib/dashboard-nav.ts` holds the nav config and `visibleNavFor(role)`, outside
the sidebar component so the role gate is testable without a NextAuth session.

**Two sets of headings.** An admin's eighteen destinations sit under six
headings (`group`: Needs a decision, Supply, People, Commercial, Setup,
Record). A host's sit in the kit's three blocks (`hostGroup`): the work itself
with no heading, then Community, then Organisation. Analytics and Plan join the
organiser's nav when their pages exist (step 16), not before.

**The shell** (step 14, the kit's `shell.jsx`): a flush 248px sidebar with the
identity card on top, which names the home organisation (the oldest live
membership, where a new event is created) and the role. It has no switcher,
because every read is scoped to the union of a person's memberships and there
is no current organisation to switch. Then a 60px sticky top bar with
breadcrumbs, a visible ⌘K field (hosts are offered "Search events…", never
people), a Create event pill gated on `mayCreateEvents`, and the account menu.
The content is at most 1200px wide, with 28/32/56 padding and 24px between
blocks. Below 768 the sidebar is a sheet.

**The nav gate must agree with `lib/rbac.ts`.** It drifted once: the nav hid
Chatrooms from `venue_owner` while `canModerateChat` granted venue owners
moderation over their own events and the messaging page's `canManageEvent` gate
agreed. A whole role was locked out of a screen the authorization layer had
always been willing to serve. `__tests__/dashboard-view.test.ts` guards this.

## Gradients

### One gradient element per screen, plus the plan-card stripe (R4)

A screen gets one gradient element, normally its single `HeroMetric`. If a second
element wants the gradient, the screen has two priorities.

The one exception is the sidebar plan card's `--gradient-brand` stripe. It sits
on every screen as a brand constant, the way the logo does, so it does not count
against the screen's one.

### The brand gradient and the interface gradient are different, on purpose

Two gradients exist, and having both is not drift. Decided 2026-08-16 (app #181,
#182). Each has **one** value, declared once in `app/globals.css`, and that value
matches the design kit's `tokens/colors.css`:

```css
--gradient-brand: linear-gradient(135deg, #f05423 0%, #bf5a6d 50%, #915da7 100%);
--gradient-ember: linear-gradient(135deg, #ff906d 0%, #ff6d8d 100%);
```

`--gradient-brand` is the mark's gradient: hero washes, stripes, the lifecycle
dot. It used to be declared twice in `globals.css` as a two-stop `#f05423 →
#8f49aa`. The kit had the three-stop value above, and this file recorded a third,
`#F04C16 → #8F55A6`, sampled from the app's logo artwork. They are reconciled to
the kit's value. The logo is a raster and keeps its own pixels. In the app,
`EMBER_GRADIENT` is the same coral to pink as `--gradient-ember`.
`__tests__/theme-tokens.test.ts` fails if either value is declared twice or this
file stops quoting it.

**The mark's gradient cannot carry text.** Contrast of ink (`#0D0C0C`) and white
text at each stop:

| | ink text | white text |
|---|---|---|
| brand `#f05423` → `#bf5a6d` → `#915da7` | 5.58 → 4.55 → **4.02** | **3.50** → 4.29 → 4.85 |
| ember `#ff906d` → `#ff6d8d` | **8.80 → 7.27** | 2.22 → 2.68 |

WCAG AA wants 4.5:1. The brand gradient starts bright and ends dark, so ink
falls under the floor at the purple end and white falls under it at the orange
end: **no single label colour is readable across its whole sweep**. The
interface gradient holds ink far above the floor the whole way, which is why
every gradient button uses it.

So: **the mark is the mark, and the interface is the interface.** Anything with
words on it uses `--gradient-ember`. Neither is "wrong", and neither should be
changed to match the other.

## The monogram has two cuts

`monogram-white.png` is the drawing. `monogram-white-bold.png` is the same
artwork with its strokes dilated from 4.86% to 6.40% of the mark's width, and
exists for **small sizes only** — at 32pt in the tab bar the thin cut draws a
1.35pt line against roughly 2pt for every other glyph in the row. The splash
and the intro keep the original; at 118pt the thin cut is the better drawing.

A genuinely **filled** variant was attempted mechanically, by flood-filling the
regions the strokes enclose. It destroys the mark — the B becomes a blob and
stops being a letterform. A filled cut is still worth having and still needs a
designer to draw it.

**The mark is optically centred, not box centred.** Its bounding box is exact,
8pt of padding on all four sides, and it still reads as sitting left: the ink is
stacked solid bars on the left and tapers to a point on the right, so its centre
of mass is 9.2% left of the canvas centre. Box-centred and mass-centred disagree
by 9%; the tab bar uses the midpoint, a 5% shift. Anything that draws this mark
inside a circle needs the same correction.
