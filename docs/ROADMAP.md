# Roadmap

The working ledger. Four sections: **Now**, **Next**, **Validated — not doing**,
and **Done**.

**The rule.** Every item from any plan lands in `Now` or `Next` before work
starts, and moves to `Done` in the same PR that finishes it. Nothing ships
without this file moving. An item that turns out to be a bad idea goes to
**Validated — not doing** with the reason, so nobody proposes it again in three
months.

This started as "things the marketing site claims that the product does not do".
That list still lives here, marked, because copy promising a feature is a debt
and undocumented copy promising a feature is a debt nobody is tracking.

Nothing here is scheduled. Pricing is undecided — everything is free.

---

## Now

Nothing in flight.

---

## Next

### 1. Matchmaking — the surface

Schema and ranking shipped in 0.49.0. What is left is the API and the client:

- `GET /events/[eventId]/matches` and `POST .../like`, with the mutual-like
  handshake that opens a conversation
- Collecting intent and interests at first check-in
- **The Expo app.** None of this is reachable until the match screen, the intent
  picker and the reveal toggle exist there

Decided:

- **One pool.** Intent is a tag and a ranking signal, never a partition
- **Anonymous by default**, opt in to reveal, per event
- **No match score.** Name the concrete overlaps — "you both picked Techno and
  Board games"
- Rank on the **structured** `user_interests → categories` graph, IDF-weighted so
  a shared niche category outweighs a shared "Music". `profiles.interests` is
  free text and cannot be compared
- `gender` / `interested_in` exist on the schema and are **not yet read by the
  ranking** — dating-specific filtering is its own decision
- Onboarding asks **nothing before check-in**; intent and interests are collected
  at first check-in, and both are things matching needs anyway. Gender is asked
  only if intent includes dating

### 2. Host coverage gaps

Measured against 2026 industry KPI guidance
([vFairs](https://www.vfairs.com/blog/event-kpis/),
[Bizzabo](https://www.bizzabo.com/blog/kpis-to-measure-event-success),
[InEvent](https://inevent.com/blog/others/25-key-metrics-for-measuring-event-success.html)).
The during-event story is the strong one and the differentiator; these are the
holes.

| Gap | Note |
|---|---|
| **Waitlist** | Nothing exists. Real for capacity-constrained events |
| **Portfolio calendar** | Events are a table only — no month view across a run |
| **Venue: multi-room / concurrent events** | Occupancy is per event; an owner running two rooms has no building total |
| **Venue: availability calendar** | "My venues" shows utilisation after the fact, not what is bookable |
| **NPS** | Ratings exist; NPS is the benchmark every organiser reports upward |
| **Attendee demographics** | Deliberately thin for privacy. Decide explicitly rather than leave it implied |

### 3. Smaller, known

- **Per-occurrence capacity.** `event_occurrences.capacity` exists and is unread.
  A conference selling fewer seats on the last day wants it
- **The feedback window** closes 24 h after the *last* day, so day-one problems
  surface at the end of the week. Belongs to the chat lifecycle sweeper
- **No client sends presence pings.** Endpoint and sweeper are live; the Expo app
  has to call `…/presence` for the loop to close
- **`events.current_capacity`** is written by nothing and read by nothing. Drop
  the column once production logs confirm it
- **`is_recurring`** is a dead flag still exposed to mobile as `isRecurring`
- **Analytics the copy promises** — funnels, cohort retention, revenue
  attribution. There is no ticketing and therefore no revenue. The copy is
  cheaper to change than the features

---

## Validated — not doing

**Dual profile for dating vs networking.** A second profile doubles the
onboarding friction the design exists to minimise, and splitting a new app's pool
empties both halves. The overlap-based card already carries the context a
separate dating profile would have.

**A match percentage.** A number implies a precision the data cannot support and
invites gaming. Naming the actual overlapping categories explains itself.

**Attendee unmasking.** A design round proposed a break-glass flow: a host files
a safety report and sees one attendee's real identity, audited. It inverts a
privacy guarantee the product makes everywhere else — today real identities never
reach a host at all — and deserves deciding on its own rather than arriving
inside a layout import.

**Financial, sponsorship and pipeline metrics.** Every one assumes ticketing.
There is none, so there is no revenue to attribute.

---

## Done

### 0.49.0

- **Matchmaking schema and ranking** (#162). `connection_intent`, per-event
  intent and reveal, `event_likes`, and `lib/matching.ts` with IDF-weighted
  overlap. Plus a migration bug that would have broken every check-in: Prisma
  models scalar lists as nullable with no default, and `NOT NULL DEFAULT '{}'`
  passed `db push` as "in sync" while failing every insert.

### 0.48.0

- **Sentiment has its keystone** (#161). `lib/sentiment-sweeper.ts` classifies
  open-room messages into `event_feedback`, which the live screen and the
  feedback screen have always read and never had. Plus `room_died` now fires,
  and two query bugs the integration test caught: `not: "hidden"` dropped every
  unmoderated message, and `feedback: null` did not filter at all.

### 0.47.0

- **`/apply` matches the landing page** (#160). Scoped light theme, the warm
  wash, the brand chip, the real lockup, and the dead 600px gap in the left
  column filled with the three honest reassurances. Per
  `blendnorglanding/rabat/docs/APPLY_PAGE_DESIGN_BRIEF.md`.

### 0.46.0

- **The seven identity and DM holes closed** (#159). The attendee list handed out
  every attendee's real name and photo while every other view of the room
  returned a pseudonym; `POST /conversations` opened a DM from two user ids and
  nothing else; "block" wrote no block; the send path checked one direction of
  it; the two conversation-creation paths ordered the pair differently so the
  unique constraint could be evaded; message requests had no co-presence test;
  and `goals` / `looking_for` survived account deletion.

### 0.45.0

- Attendance panel and occupancy hero (#156). Also unified the two divergent fill
  calculations — the live tab capped at 100% against staff-inclusive occupancy
  while the occupancy panel measured guests uncapped, so one room read "full" and
  "110%, 8 over" on two screens
- `/` is the login rather than a second marketing pitch (#155)
- Dashboard screens size against the content column, not the window (#157)
- Host-split documentation and the certificate ordering constraint (#154)

### 0.44.x

- `dashboard.blendn.app` as a second domain on one service (#152)
- Humans redirected to the dashboard host, misconfigured clients rejected (#153)

### 0.40–0.43

- Occupancy derived rather than stored; check-in stops refusing at capacity;
  staff told from guests by organisation membership
- One checkout path, and the check-in route finally has an integration test
- Presence: ping while checked in, prompt on leaving, sweep the rest, with a
  mass-checkout guard
- Multi-day: `event_occurrences`, per-day check-in, new-vs-returning, retention
- Nominatim proxied server-side
