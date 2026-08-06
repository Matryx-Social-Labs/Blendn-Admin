# Blend'n — event detail brief

Paste into Claude Design. Scope is **one screen**: `/dashboard/events/[id]`, the
page you land on when you click any event anywhere in the dashboard.

Everything else in the dashboard was designed and built in the previous round.
This is the one screen where the implementation and the design genuinely
diverge, and the divergence is structural rather than cosmetic.

---

## The product, in one paragraph

**Blend'n** is an event networking app in India. Attendees discover events, check
in with GPS, and talk in a pseudonymous event chatroom that closes 24 hours after
the event ends. The web dashboard is an **operations console** used by three
roles: `app_admin` (Blend'n staff), `organizer` (a company that runs events), and
`venue_owner` (a company that owns venues). Authorization resolves on
**organisation membership**, not individual identity — a host is a company with
`owner`/`admin`/`staff` members.

---

## What is wrong today

The page has a tab bar reading **Overview · Live · Attendees · Chat · Feedback**.
It is lifecycle-aware already: `Live` only appears while the event is running,
`Feedback` only once the chat window opens. That part works and should be kept.

Three things are broken underneath it.

### 1. Overview is an edit form

`activeTab === "overview"` renders `<EventEditor>` — the same component used by
`/dashboard/events/new`, pre-filled.

So clicking an event to see **how it is doing** drops you into a form for
**changing it**. There is nowhere in the product that answers "how is this event
going", which is the question the page exists to answer. Publish state, fill
against capacity, RSVP pacing, who is coming, what the room is saying — none of
it is on the screen you reach by clicking an event.

### 2. Three of the five tabs are not tabs

`Attendees`, `Chat` and `Feedback` all `redirect()` to other routes. The tab bar
is a nav menu wearing tabs' clothing: clicking a tab navigates off the page, the
tab bar disappears, and getting back to the event means the browser Back button.

The redirects exist for a good reason — those screens are implemented once, at
`/dashboard/events/[id]/messaging` and `/[id]/feedback`, rather than duplicated.
**Keep one implementation.** The question for you is what the *shell* should be
so that a tab behaves like a tab.

### 3. A venue owner gets a sentence

When `canEdit` is false, the whole page body is one paragraph:

> *"This event is run by someone else. Open Live or Chat to operate the room."*

A venue owner has a real stake in an event in their building — is it filling, are
people turning up, is the room behaving — and the screen tells them to go
somewhere else. This is the emptiest screen in the product for a role that is not
a lesser user.

---

## What to design

### A. The Overview tab

The page's front door. It should answer, in this order:

1. **What is this event, and what state is it in?** Title, date, venue, and
   whether it is a draft, published, live now, or over.
2. **Is it working?** For an upcoming event that means fill against capacity and
   whether RSVPs are pacing ahead of or behind past events. For a past one it
   means turn-up rate, rating, and what the feedback said.
3. **What can I do about it?** The actions belong here — edit, announce, cancel —
   not competing with the answer.

Design **four states**, because the same screen means different things across the
lifecycle and today it means one thing always:

| State | The question |
|---|---|
| **Draft** | What is stopping this from being published? |
| **Upcoming** | Will it fill? |
| **Live now** | Is it going okay right now? |
| **Over** | Was it good, and what do I do differently? |

Exactly **one hero metric** per state, carrying the brand gradient — fill % when
upcoming, checked-in count when live, turn-up when over. If a second element
wants the gradient, the screen has two priorities and one is wrong.

### B. The tab shell

Make a tab behave like a tab: the header, the event identity, and the tab bar
persist while the panel below changes.

Constraint that matters: **do not duplicate the attendee list, the chat view or
the feedback view.** They are implemented once and should stay that way. Design
the shell and say how the existing panels sit inside it.

### C. The venue owner's Overview

Same screen, honestly scoped. They get the operational bucket —
`eventPermissions` grants them chat, moderation and the attendee list for events
at venues their organisation owns — and no editorial control.

So: no edit button, no publish, no cancel. But everything about **their room**:
is it filling, are people turning up, how is the chat behaving, and how does this
organiser compare to others who have booked the same venue. Design the
scope note as a fact about the relationship, not as an apology for a missing
button.

### D. The edit route

`/dashboard/events/[id]/edit` now exists and holds the staged editor (Basics →
Location & Venue → Schedule → Categories → Capacity & Check-in → Media → Review).
Design how Overview hands off to it and back — the return path after saving is
the part that is easy to leave dangling.

---

## Data that actually exists

Design against these. **Do not invent metrics** — the previous round mocked up
session devices and locations that NextAuth does not record, and they had to be
cut during implementation.

**On the event:** title, description, short description, slug, start/end time,
timezone, status (`draft`/`published`/`cancelled`/`completed`), visibility,
`max_capacity`, `current_capacity`, cover image, venue (linked record *or* free
text — most events are at places not on the platform), city/address/lat/lng,
`check_in_radius`, categories (two-level: parent + children, one marked primary),
`is_featured`, `is_recurring`.

**Related:** `event_rsvps` (going / interested / not going, timestamped — this is
what pacing is built from), `event_check_ins` (GPS-validated, `checked_in` /
`checked_out`), `event_ratings` (1–5), `event_feedback`, `chat_messages` +
`chat_group_members` (pseudonymous — attendees have an `anonymous_name` and hosts
never see real identities), `moderation_flags`, `event_announcements`.

**Derived, already built:** RSVP pacing vs capacity, arrival curve, rating
distribution, no-show rate, sentiment categories over feedback.

**Empty is the common case.** This product has ~44 users. An event with zero
RSVPs is normal, not an edge case, and every state must say what will fill it
rather than rendering a broken-looking chart.

---

## Brand and technical constraints

- **Colour:** `--primary` `#F05423`, brand purple `#8F49AA`, rose `#BE5C71`, ink
  `#0D0C0C`. Charts walk `--chart-1 → 2 → 3` (orange → rose → purple). Text on
  orange is **ink, not white** — white is 3.4:1 and fails WCAG AA.
- **Type:** Satoshi, weights 300/400/500/700/900. **There is no 600** — do not
  design against a weight that does not exist.
- **Dark-first.** No theme toggle.
- **Container queries, not viewport breakpoints.** Content sits in
  `@container/main`; use `@sm/main:`, `@3xl/main:`. The sidebar is 288px and
  collapsible, so viewport and content width differ by a large changing amount.
- **One `h1` per page**, owned by the top bar. Page bodies start at `h2`.
- **Icons outlined**, never filled.
- **Charts are honest by construction:** axes start at zero, zero draws as zero,
  funnel stages are nested subsets, empty states say what will fill them.
- Available primitives: avatar, badge, button, calendar, card, chart, checkbox,
  drawer, dropdown-menu, form, input, label, popover, progress, radio-group,
  select, separator, sheet, sidebar, skeleton, slider, sonner, switch, table,
  tabs, textarea, toggle, tooltip. **No `dialog`** — confirmations are inline or
  in a sheet.
- Charts and tables read the **global date range** from the top bar. An event
  detail page is about one event, so say whether the range applies here at all —
  if it does not, the control should be hidden rather than present and ignored.

---

## Deliver

1. Overview in **four lifecycle states**, desktop and mobile — an organiser will
   check pacing from their phone an hour before doors.
2. The **tab shell**, showing how the existing attendee/chat/feedback panels sit
   inside it without being reimplemented.
3. The **venue owner's** Overview.
4. The **handoff** to the staged editor and back.
5. Anything new as a **component sheet**, so it gets built once.

The rest of the dashboard is designed and shipped — match it rather than
introducing a new language. `docs/CLAUDE_DESIGN_BRIEF.md` (the previous round)
and `docs/DESIGN_SYSTEM.md` are the reference.
