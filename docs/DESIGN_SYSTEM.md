# Design system

How the dashboard implements the Blend'n Brand Guideline. Source of truth for
colour, type, and the layout rules that are easy to break by accident.

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

This is not stylistic. The sidebar is 288px and collapsible, so viewport width
and content width differ by a large, changing amount. The KPI grid and the
spotlight grid directly below it once used different systems, and collapsing the
sidebar reflowed them at different widths — they visibly fell out of step.

### One `h1` per page

`components/site-header.tsx` owns it, and it holds the page *name*. Page bodies
start at `h2`. The header used to render the page name as a 0.68rem uppercase
eyebrow with the description sentence as the `h1`, which put the wrong string in
the document's only landmark heading.

### Hierarchy comes from type, not boxes

`MetricTile` has no card chrome at all, and exactly **one** `HeroMetric` per
screen carries the brand gradient. If a second element wants the gradient, the
screen has two priorities and one of them is wrong.

The old overview put eleven things in bordered rounded cards at identical visual
weight, so nothing read as primary and the eye had nowhere to land.

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
| Leads with | moderation attention strip | next event's fill %, in 40px type | per-venue comparison table |
| Primary chart | signups vs active (the gap is the vanity) | RSVP pacing vs capacity | utilisation heatmap, day x slot |
| Secondary | activation funnel | rating distribution | rating distribution, busiest venue |
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

**The nav gate must agree with `lib/rbac.ts`.** It drifted once: the nav hid
Chatrooms from `venue_owner` while `canModerateChat` granted venue owners
moderation over their own events and the messaging page's `canManageEvent` gate
agreed. A whole role was locked out of a screen the authorization layer had
always been willing to serve. `__tests__/dashboard-view.test.ts` guards this.

## The brand gradient and the interface gradient are different, on purpose

Two gradients exist and they are not a drift. Decided 2026-08-16 (app #181,
#182).

| | | |
|---|---|---|
| **The mark** | `#F04C16` → `#8F55A6` | orange to purple |
| **The interface** | `#FF906D` → `#FF6D8D` | coral to pink — `EMBER_GRADIENT` |

**The mark's gradient cannot carry text.** Measured, dark text and white text
against each end:

| | dark text | white text |
|---|---|---|
| mark `#F04C16` → `#8F55A6` | 3.69 → **2.58** | 3.65 → 5.23 |
| UI `#FF906D` → `#FF6D8D` | **6.07 → 5.02** | 2.22 → 2.68 |

WCAG AA wants 4.5:1. The mark's gradient starts bright and ends dark, so dark
text drowns at one end and white text drowns at the other — **no single label
colour is readable across its whole sweep**. The interface gradient holds dark
text above the floor the entire way, which is why every gradient button in this
product uses it.

So: **the mark is the mark, the interface is the interface.** The logo keeps its
own gradient wherever the logo is drawn as artwork. Anything with words on it
uses `EMBER_GRADIENT`. Neither is "wrong", and neither should be changed to
match the other.

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
