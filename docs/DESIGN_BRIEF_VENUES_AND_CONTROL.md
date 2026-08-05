# Design brief — venues, host control, and post-event feedback

Round two. Paste as the prompt into the **existing** Blend'n Design System
project (`36e286f2-4b1c-4db3-ac3d-0f4e4ee99d26`). Attach nothing new — the brand
manual, logos and fonts are already in `uploads/` and `assets/`.

---

## What this is

You designed the Blend'n operator dashboard in this project already —
`ui_kits/dashboard/` with per-role overviews, a moderation queue, and the
component set in `components/`. That shipped: it is live, built against the real
schema, and the tokens, type scale and layout rules are now in the codebase.

**This is an extension of that work, not a replacement.** Reuse `MetricTile`,
`HeroMetric`, `DataTable`, `EmptyState`, `RatingBars`, `Badge`, `Button`,
`SidebarNav`, `PageHeader` and the chart primitives in `charts.jsx`. Add
components only where the existing set genuinely cannot express something, and
say which and why when you do.

Implementing your design surfaced that the data model could not express what the
product actually is. That has now been decided, and this brief describes the
decided model. Design against it as fact.

## The thing that was missing: venues

There was no venue. `events.venue_name` was free text, and a "venue owner" was a
role whose events happened to carry venue names. Byg Brewski could not exist as
a thing.

A venue is now a real record — a physical place like Byg Brewski or Shiro in
Bangalore — with an optional owner. Two independent axes on every event:

```
events.organizer_id  ──▶  who RUNS it
events.venue_id      ──▶  where it IS  ──▶  venues.owner_id  (nullable)
```

**Permissions derive from both, not from the role:**

| Actor | Condition | Editorial (edit, publish, cancel) | Operational (chat, moderation, attendees) |
|---|---|---|---|
| admin | always | ✅ | ✅ |
| organiser | it's their event | ✅ | ✅ |
| venue owner | it's at their venue | ✗ | ✅ |
| venue owner | it's their own event | ✅ | ✅ |

The principle: a venue owner controls **what happens in their building** — the
chatroom, moderation, who is walking in — but not the event itself, because the
event is not theirs to change. Host it yourself and you are the organiser, so
you get both.

**Critically, venue linkage is optional and usually absent.** Most events happen
at places that are not on the platform: the organiser types a location and no
venue record exists. Those events have no venue owner and nothing changes for
them. Your designs must treat "no linked venue" as the *common* case, not the
edge — a venue picker that implies you must choose from a list is wrong.

When an organiser does pick a claimed venue, it **auto-links immediately**. The
venue owner is not asked first; they find out because it appears on their
dashboard, and they can **dispute and unlink** it. Design that arrival — an
event you did not agree to, showing up at your venue — as a real moment, not a
row that quietly appears.

## Screens to design

### 1. Venue management

For venue owners: their venues, each with utilisation, ratings, upcoming
bookings. You designed a version of this (`screen-myvenues.jsx`) against derived
data; now venues are real records, so they have an address, a true capacity, and
an identity independent of any event.

For admins: all venues, who owns each, which are unclaimed, and assigning an
owner.

New: the **dispute** flow. A venue owner sees an event they did not agree to and
unlinks it. What happens to the organiser, who now has an event with no venue?

### 2. Suspending a host

Removing an organiser or venue owner means **suspending**, never deleting —
deleting cascades their events, every check-in and every chat message, which
destroys other people's history to punish one person.

Suspension is two decisions, and the design must keep them separate:

1. **The account** — access revoked, reversible, reason recorded.
2. **Their events** — a disposition step listing every upcoming published event
   with its attendee count, defaulted by risk:
   - starts **< 48h with RSVPs** → default *leave running*; cancelling on the
     day punishes attendees for the organiser's conduct
   - starts **≥ 48h** → default *unpublish*; reversible, nobody has travelled
   - **at a claimed venue** → also offer *transfer to the venue owner*
   - always available → *cancel and notify attendees* (sends a push)

The hard part is making a screen where someone is angry and in a hurry does not
accidentally cancel six events with 200 committed attendees. Show the blast
radius before the action, not after.

### 3. Onboarding an organiser

A venue owner wants a specific organiser to host at their venue, and that
organiser has no account. They submit the organiser's details; an admin verifies
and onboards.

Design the request form, the venue owner's view of their pending requests, and
the admin's review queue. Account creation already generates a one-time password
shown once and never recoverable — design how that gets handed over safely.

### 4. Permission-aware event and chatroom access

Every event screen now shows different affordances to different people. A venue
owner opening an event at their venue sees the chatroom, moderation and the
attendee list, and **no edit button** — and the absence needs to read as
deliberate, not as something failing to load.

The chatroom index currently lists **only events happening right now**, which is
wrong: it should reach any event whose chat is open, including the post-event
feedback window below.

### 5. Post-event feedback — the one that matters most

The chatroom stays open for a window after the event ends. That is deliberate
product design, not an oversight: instead of emailing attendees a survey nobody
fills in, you catch them while they are still standing outside the venue with an
opinion. A concert just ended, people are talking about the sound, the queue,
the staff. That is the honest review.

**Attendees are pseudonymous, and this is enforced, not cosmetic.** Every
attendee gets a generated name on check-in — hosts see "Quiet Otter", never a
real name or email. The API used to leak real identity; that is now fixed and
admin-only. Your design must never show a host a real attendee name.

A host may unmask exactly one way: by **filing a safety report about that
person**, with a reason, and the unmasking is written to an audit log an admin
reviews. Design that as a break-glass action that visibly costs something — it
should feel like a decision, not a button.

Messages in the feedback window are **auto-classified** as positive / negative /
neutral, and the organiser can **correct the label**. Design:
- the feedback view itself — what a host reads the morning after
- how a suggested-but-wrong label gets corrected without friction
- how confidence is conveyed, since the classifier will be wrong about sarcasm
- the relationship between this and the existing 1–5 star ratings, which is a
  separate, thinner signal

Then the harder question: what does a host actually **do** with it? A wall of
chat messages is not a report. What is the thing they take away?

## Data constraints — design only what exists

Real: venues (name, address, city, lat/lon, capacity, owner), events, RSVPs
(going/maybe/not_going), GPS check-ins, favourites, 1–5 ratings with optional
review text, chat groups and messages, per-member pseudonyms, moderation flags
(status, source, confidence, categories), user/message/event reports, push
tokens, audit logs, suspension state, feedback sentiment labels.

Not real, do not design against: session or app-open events (activity is
inferred from token refreshes, always label it a proxy), venue photos or
amenities, payments or ticketing, messaging between hosts, anything financial.

**Scale:** ~44 users, 10 events, 361 chat messages in production today. Every
screen needs a designed empty state that says what will fill it — that is the
common case, not an appendix. Then design the other end too: 5,000 events, 200
venues, a moderation queue with 400 pending flags.

## Constraints

Everything in `docs/DESIGN_SYSTEM.md` still holds. The load-bearing ones:

- **Container queries, not viewport breakpoints.** Content sits in
  `@container/main` behind a collapsible sidebar; the two systems reflow at
  different points and mixing them visibly desyncs adjacent rows.
- **One `h1` per page**, holding the page name.
- **Hierarchy from type, not boxes.** One `HeroMetric` per screen carries the
  gradient. Eleven identical cards is what the first dashboard did wrong.
- **Zero draws as zero.** Axes start at zero. Averages that hide distributions
  get the distribution shown alongside.
- **Every number leads somewhere.** A dead-end metric is decoration.
- Satoshi: 300/400/500/**no 600**/700/900. Brand purple is `#8F49AA` — the
  guideline's printed `#925D46` is a transcription error.
- White on `#F05423` is 3.4:1 and fails AA; primary surfaces use brand ink on
  orange at 6.2:1.

Desktop-first — these are operators at a desk doing dense work — but genuinely
usable on a phone. A venue owner checking whether tonight's crowd is turning up,
while standing in their own bar, is the real mobile case.

## Deliver

1. **Updated IA** — the full screen inventory per role with these additions
   folded in, and what moves or merges.
2. **The five screens above**, desktop and mobile, with empty states.
3. **New components** — only what the existing set cannot express, with the
   reason for each.
4. **The destructive-action pattern.** Suspension, event cancellation, venue
   dispute and identity unmasking are four different weights of irreversible.
   One coherent pattern that scales across them, rather than four dialogs.
5. **What you would cut.** The dashboard has grown quickly. If something here
   duplicates something already shipped, say so.

## Ground rules

Do not design a metric the schema cannot produce. If you want one that isn't
listed, say so explicitly and state what would need capturing — that is a useful
finding, just flag it rather than assuming it exists. Where you depart from the
brand guideline, say so and give the reason.
