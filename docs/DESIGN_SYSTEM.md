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

### Do not floor a bar chart's width

`funnelBarWidth` in `lib/dashboard-view.ts` returns 0 for a zero value. The
previous inline version was `Math.max(10, …)`, which drew an empty funnel stage
as if it had a tenth of the best stage's traffic. A non-zero value still gets a
2% floor so a single check-in out of fifty thousand stays visible — that is a
rounding courtesy for values already above zero, not an invented one.

## What each role sees

Every figure on the overview used to be trailing 30-day reporting, which answers
"how did we do" and never "what needs attention now". `upcoming` and `breakdown`
sit directly under the KPI cards for that reason.

| Section | app_admin | organizer | venue_owner |
|---|---|---|---|
| Metrics (4) | users, active audience, supply, check-ins | portfolio, audience, demand, chat | same as organizer |
| Spotlights (5) | repeat, host activation, push reach, rating, **moderation backlog** | repeat, fill, rating, top city, **turn-up rate** | …top venue, **turn-up rate** |
| `upcoming` | next events platform-wide | own next events | own next events |
| `breakdown` | **moderation queue** by review state | **rating spread** 1–5 | **events by venue** |
| Trend | acquisition / supply / attendance / engagement | audience-scoped equivalent | same |
| Funnel | signups → onboarded → active → checked in | events → published → audience → ratings | same |

Three of these close gaps the audit found:

- **Moderation was invisible.** `moderation_flags` is a core table and its
  pending count is the most time-sensitive number an admin has, but the only way
  to see it was to open one event's messaging page at a time.
- **Turn-up rate** is the gap between committed RSVPs and actual check-ins — the
  no-show rate, which decides catering and whether to overbook. It is capped at
  100% because walk-ins check in without ever RSVPing, and "112% turned up"
  reads as a bug rather than a good night.
- **Events by venue.** A venue owner with three venues previously saw one
  blended number, which is the opposite of what the role exists to answer.

`fillPct` is `null`, not `0`, when an event states no capacity. There is no
target to fall short of, so `fillTone` renders it neutral — zero would paint it
in the alarm colour.

## Navigation and roles

`lib/dashboard-nav.ts` holds the nav config and `visibleNavFor(role)`, outside
the sidebar component so the role gate is testable without a NextAuth session.

**The nav gate must agree with `lib/rbac.ts`.** It drifted once: the nav hid
Chatrooms from `venue_owner` while `canModerateChat` granted venue owners
moderation over their own events and the messaging page's `canManageEvent` gate
agreed. A whole role was locked out of a screen the authorization layer had
always been willing to serve. `__tests__/dashboard-view.test.ts` guards this.
