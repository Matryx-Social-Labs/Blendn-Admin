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

### 1. Sentiment — write the keystone

**Correction to a previous entry here, which said this was "partly real".** It is
not running anywhere. `classifyMessages` has **zero production call sites** and
nothing issues `event_feedback.create`. The live event screen and the feedback
screen both read a permanently empty table.

Everything else is built and tested: the taxonomy, the free lexicon tier, the
LLM tier with `BATCH_SIZE = 20`, the `event_feedback` table with three indexes
and a unique `message_id` for in-place re-classification, `buildLiveSnapshot`
aggregation, and two alert rules (`safety` fires on one message; `mood_sliding`
at ≥10 classified and ≥40% negative).

What is missing is the call. It belongs on the fire-and-forget seam beside
`void moderateMessage(...)`, never inside the 1 s pre-broadcast race, and it must
drain a per-event queue in batches — one API call per message defeats the
two-tier design that keeps this at single-digit calls per hour.

The honest case for the feature needs no inflated statistics, and an earlier
`taxonomy.ts` carried one ("~45% of venue incidents") that appears in neither
source it cited. Removed. Post-event surveys draw
[5–15% responses](https://www.explori.com/blog/what-is-a-good-post-event-survey-response-rate),
attendees forget [most detail within a day](https://www.surveysensum.com/blog/post-event-feedback-survey),
and [real-time room sentiment stays rare](https://www.aiforevents.co/blog/ai-sentiment-analysis-events)
because every alternative needs cameras, wearables or attendee effort — while
this reads a chatroom people already use.

### 2. Matchmaking

**Does not exist**, despite the README describing it — no route, no ranking
module, and git history has never held one. `/events/[eventId]/checkins` is the
raw material: the room, sorted by check-in time.

Decided:

- **One pool.** Intent is a tag and a ranking signal, never a partition
- **Anonymous by default**, opt in to reveal, per event
- **No match score.** Name the concrete overlaps — "you both picked Techno and
  Board games"
- Rank on the **structured** `user_interests → categories` graph, IDF-weighted so
  a shared niche category outweighs a shared "Music". `profiles.interests` is
  free text and cannot be compared
- Onboarding asks **nothing before check-in**; intent and interests are collected
  at first check-in, and both are things matching needs anyway. Gender is asked
  only if intent includes dating

### 3. Host coverage gaps

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

### 4. Smaller, known

- **Per-occurrence capacity.** `event_occurrences.capacity` exists and is unread.
  A conference selling fewer seats on the last day wants it
- **The feedback window** closes 24 h after the *last* day, so day-one problems
  surface at the end of the week. Belongs to the chat lifecycle sweeper
- **No client sends presence pings.** Endpoint and sweeper are live; the Expo app
  has to call `…/presence` for the loop to close
- **`events.current_capacity`** is written by nothing and read by nothing. Drop
  the column once production logs confirm it
- **`is_recurring`** is a dead flag still exposed to mobile as `isRecurring`
- **`room_died`** is a declared `LiveAlertKind` no branch ever emits
- The 1 s moderation `Promise.race` never clears its losing timer
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
