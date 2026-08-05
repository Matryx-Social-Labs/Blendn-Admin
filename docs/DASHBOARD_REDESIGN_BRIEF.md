# Blend'n admin dashboard — full redesign brief

Paste this as the prompt. Attach: the Brand Guideline PDF, the five logo PNGs,
and the codebase.

---

## What you're designing

The web admin dashboard for **Blend'n**, an event-networking mobile app. People
discover events, RSVP, check in on location, and chat with other attendees in
per-event chatrooms and DMs. The mobile app is a separate React Native codebase;
this dashboard is the operator-facing surface for the people who run the
platform and the events on it.

Redesign it **completely, from scratch**. Do not treat the current screens as a
starting point — treat them as evidence of what the data supports and what
questions users bring. Everything about the current layout is open to change.

**Desktop-first**, because these are people at a desk doing operational work
across dense tables and charts. But it must be genuinely usable on a phone — an
organiser checking how tonight's event is filling while walking to the venue is
a real scenario. Mobile is not a scaled-down desktop; decide what a phone user
actually needs on each screen.

## Who uses it, and what they're actually trying to find out

Three roles, one codebase, gated by `lib/rbac.ts`. They have genuinely different
jobs — the current dashboard largely gives the last two the same screen with two
strings swapped, which is the biggest single thing to fix.

**`app_admin`** — platform operator, and the person who has to tell the
investor story. Their questions:
- Is the platform growing, and is that growth real engagement or vanity signups?
- Do we have host liquidity — are organisers actually publishing events, or is
  supply concentrated in three accounts?
- Is anything on fire right now? Specifically: is there flagged content sitting
  unreviewed in the moderation queue?
- Which cities and categories justify expansion?

**`organizer`** — runs events. Their questions:
- How is my next event pacing, and do I need to push it? (This is the *first*
  question, and the current dashboard cannot answer it at all.)
- Who came back for a second event?
- What's my no-show rate — how many RSVPs actually walk through the door?
- Which of my past events worked, and what did they have in common?
- Is the chat in my event healthy or does it need moderating?

**`venue_owner`** — operates one or more physical venues that host events. Their
questions:
- Which of my venues is performing, and which is dead weight?
- What's my utilisation — how many nights a week is each room being used?
- When are my peak days and times?
- Are events at my venue rated well? Bad ratings at one room are a facilities
  problem, not an event problem.

A venue owner with three venues currently sees a single blended number for all
of them. That is the opposite of what the role exists to answer.

## The data that actually exists

Design against this. **Do not invent metrics the schema cannot produce** — a
beautiful chart of data we don't have is worse than no chart. Full schema is in
`prisma/schema.prisma`; the relevant tables:

| Table | What it gives you |
|---|---|
| `User` / `profiles` | accounts, roles, `onboarded` flag, interests, created dates |
| `events` | status (draft/published/cancelled), visibility, start/end times, `city`, `venue_name`, `max_capacity`, `current_capacity`, lat/lon, soft delete |
| `event_rsvps` | `going` / `maybe` / `not_going` per user per event |
| `event_check_ins` | GPS-validated attendance, `checked_in` / `checked_out`, timestamps |
| `event_favorites` | saves — a demand signal ahead of RSVP |
| `event_ratings` | 1–5 stars, per user per event |
| `event_reports` / `user_reports` / `message_reports` | user-submitted trust & safety reports |
| `chat_groups` / `chat_messages` / `message_reactions` | per-event group chat |
| `private_conversations` / `private_messages` | DMs between attendees |
| `moderation_flags` | pipeline output: `pending` / `approved` / `rejected`, `source`, `confidence`, `categories` JSON, `auto_action` |
| `blocked_users` / `message_requests` | social graph safety |
| `push_tokens` | push-reachable audience |
| `mobile_refresh_tokens` | proxy for active mobile sessions |
| `categories` | event taxonomy |
| `audit_logs` | admin actions, for accountability |

**Scale reality:** production currently holds ~44 users, 10 events, 361 chat
messages. This is pre-launch. Design for the shape of the data, not today's
volume — but every screen needs a considered **empty state**, because most
screens *are* empty right now and will be for a while. An empty state that
explains what will fill it and how is a first-class part of this design, not an
afterthought.

Also design for the other end: what does the events table look like at 5,000
events? Where does pagination, filtering, and search go?

## Brand

The guideline PDF is attached. Extracted essentials:

| Role | Value |
|---|---|
| Primary orange | `#F05423` |
| Primary purple | `#8F49AA` |
| Secondary rose | `#BE5C71` |
| Secondary ink | `#0D0C0C` |
| Secondary white | `#FFFFFF` |
| Signature gradient | orange → purple |
| Typeface | Satoshi |
| Icons | outlined only, never filled |

**Note on the purple.** Page 6 of the guideline labels that swatch `#925D46`,
which is a muted brown. The swatch beside the label renders `#8F49AA`, and the
CMYK printed with it (47/74/0/0) is also a purple. Two of three agree, so the
printed hex is a transcription error. Use `#8F49AA` and flag it if you disagree.

**Satoshi ships in 300/400/500/700/900 — there is no 600.** Do not design
type scales that depend on a semibold weight; CSS will resolve 600 up to 700,
which is heavier than a semibold and will look wrong if you specified it as one.

The brand is dark-first — every page of the guideline is on `#0D0C0C`. The app
is currently dark-only. You may propose light mode, but justify it: these are
operators staring at dense data, and a decision either way should be deliberate.

Accessibility is not negotiable. Note specifically that **white text on
`#F05423` is 3.4:1 and fails WCAG AA for body text**; the current implementation
uses the brand ink as the foreground on primary surfaces for 6.2:1, which also
matches the guideline's own monogram-on-orange tile. Any colour pairing you
propose needs to clear AA for its size class.

## Technical constraints — these are real, not suggestions

- **Next.js 16 App Router, React 19.** Server components fetch data, client
  components render interactivity. Charts and filters are client-side.
- **Tailwind v4**, CSS-first configuration. Theme tokens live in
  `app/globals.css` under `@theme` — there is no `tailwind.config.js`.
- **shadcn/ui** primitives (`components/ui/*`) and **recharts** for charts.
  Prefer composing these over introducing a new UI or chart library. If you
  genuinely need something else, say what and why.
- **`@tabler/icons-react`** for icons — outline by default, which matches the
  guideline. Don't switch to a filled set.
- **Use container queries, not viewport breakpoints.** The dashboard content
  sits inside `@container/main`. The sidebar is 288px and collapsible, so
  viewport width and content width differ by a large and *changing* amount.
  Grids keyed to `md:`/`xl:` reflow at different points from grids keyed to
  `@md/main:`/`@xl/main:`, and mixing the two makes adjacent rows visibly fall
  out of step. This bug shipped once already.
- Layout chrome today: 288px sidebar, 48px sticky header. Both are open to
  redesign — including removing the sidebar in favour of something else — but
  say what you're changing and why.

## What's wrong with the current dashboard

An audit found these. They're context for what to avoid, not a repair list —
you're starting over.

1. **It was entirely trailing.** Every number was a 30-day lookback. It could
   tell you how last month went and nothing about the event running Thursday.
   Forward-looking pacing has since been added, but the information architecture
   still buries it.
2. **Role differentiation was cosmetic.** `venue_owner` got the `organizer`
   dashboard with two strings swapped.
3. **One chart for the whole page**, a six-point area chart, plus a
   hand-rolled div "funnel". A second chart was added recently. It's still thin
   for the number of questions these roles have.
4. **Card soup.** Hero card, four KPI cards, five spotlight cards, two chart
   cards, one table card — everything is a bordered rounded rectangle at the
   same visual weight, so nothing has priority. This is the single biggest
   layout problem and the one most worth solving from scratch.
5. **Moderation was invisible** despite being the most time-sensitive admin
   concern. There is still no platform-wide moderation queue screen — only a
   per-event one buried in each event's messaging page.
6. **Inverted heading hierarchy** — the page description was the `h1` and the
   page name was a 12px eyebrow.
7. **A funnel bar with a 10% floor**, so a stage with zero people drew as if it
   had traffic. Never floor a value that can legitimately be zero.

## What "good" looks like here

- **Hierarchy over uniformity.** Someone landing on this should know within two
  seconds what needs their attention. That means some things are much bigger and
  louder than others, and most things are quieter than they are today.
- **Honest data visualisation.** Zero renders as zero. Axes start at zero unless
  there's a stated reason. Averages that hide distributions get a distribution
  alongside them. No floors, no invented minimums.
- **Every number leads somewhere.** "4 pending flags" should be clickable
  through to the flags. A dead-end metric is a decoration.
- **Density with air.** Operators want a lot on screen; that's different from
  cramped. Solve it with typographic hierarchy and spacing rhythm, not by
  removing information.
- **The brand should be felt, not pasted.** Orange everywhere is worse than
  greyscale. The gradient is the signature asset — use it where it means
  something.

## What to deliver

1. **Information architecture** — the full screen inventory and navigation
   model, per role. Which screens exist, what lives on each, what each role sees.
   Include screens that don't exist yet if the roles' questions demand them
   (a platform moderation queue is the obvious candidate).
2. **The overview screen, designed in full**, for all three roles. This is the
   centrepiece. Desktop layout and mobile layout, with the reasoning for what
   changes between them and what gets dropped.
3. **A design system spec** — type scale (Satoshi weights available: 300/400/
   500/700/900), spacing rhythm, colour token set with the semantic decisions
   made explicit (what's primary, what's destructive, what signals a positive
   trend and why), elevation and border treatment, chart palette derived from
   the brand, and the states: hover, focus, disabled, loading, empty, error.
4. **Component inventory** — what's needed, which map to existing shadcn
   primitives, which are genuinely new.
5. **Chart specifications** — which chart type answers which question for which
   role, and why that type over the alternatives. Include what each chart looks
   like with no data.
6. **Empty and loading states** — first-class, not appendix. Most of this
   product is empty today.
7. **The migration path** — what ships first, what can follow. This is a live
   product with real users on it; a redesign that only works as a big-bang cutover
   is less useful than one that can land in stages.

## Ground rules

- One `h1` per page, and it holds the page name.
- Every interactive element is keyboard reachable with a visible focus state.
- Don't design a metric the schema can't produce. If you want one that isn't in
  the table above, say so explicitly and state what data would need capturing —
  that's a useful finding, just flag it rather than assuming it exists.
- Where you depart from the brand guideline, say so and give the reason. There
  are legitimate reasons to (status colours aren't in the guideline at all), but
  they should be deliberate and stated, not silent.
