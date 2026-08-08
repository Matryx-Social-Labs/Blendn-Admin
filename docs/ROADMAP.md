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

**`USER_JOURNEY.md` is the contract** — designed vs built vs served, for all three
repos. Items here are the API half of it; the app half is `blendn/ROADMAP.md`.
Do not restate the journey in either.

Nothing here is scheduled. Pricing is undecided — everything is free.

---

## Now

Nothing in flight.

---

## Next

### 1. Interests reach the structured graph — blocks matchmaking entirely

Onboarding writes interests to `profiles.interests` (free text, from a hardcoded
emoji list). `lib/matching.ts` ranks on `user_interests → categories`, and the
endpoints that populate it (`/profiles/:id/interests`) have **zero call sites**.

Every match card therefore returns **no shared interests, for everyone**. The
ranking, the IDF weighting and the overlap-naming card are all correct and all
fed by an empty table.

Mostly app-side, but ours to make easy: decide whether `/events/:id/checkins`
should carry interests so the client need not fan out, and whether
`profiles.interests` becomes display-only or is retired.

### 2. The four designed features now in scope

From `DESIGN_HANDOFF.md`. All are in the Figma and in neither repo.

| | API today | Work |
|---|---|---|
| **Search / Filter** | `/events/search` exists and is **never called**; `/events` filters on category, date, distance | Verify the surface covers the design — then it is app-only |
| **Map** | Events carry lat/lng; `/events` sorts by distance from a point | A viewport/bounding-box query — a map pans rather than searching a radius |
| **Profile strength** | Nothing computes completeness; the attendee list hardcodes its own three-field notion | One shared definition server-side, so the meter and that filter cannot disagree |
| **Notifications centre** | Push tokens exist; no record of what was sent | The largest — a table, a write on every push, list/read endpoints |

### 3. A coarse match band

Agreed in place of the design's `Match Percentage`: **Strong / Good / Some**,
never a raw number. Not thresholds on the score — that is IDF-weighted, so its
scale depends on how rare the room's interests are, and a fixed cut would mean
different things at a techno night and a conference. Proposed:

- **Strong** — two or more shared interests, at least one rare in that room
- **Good** — one or more shared
- **Some** — nothing shared, compatible intent

Degrades honestly: a room sharing nothing shows "Some", not a fabricated 34%.

### 4. Matchmaking — the surface

Schema, ranking and the API have shipped (0.49.0, 0.50.0). What is left is the
client:

- **The Expo app.** None of this is reachable until the match screen, the intent
  picker and the reveal toggle exist there. The server side is complete and
  tested against a real database.
- **Collecting interests at first check-in.** `PUT .../matches/preferences`
  takes intent; interests still have to be picked somewhere, and the existing
  `/profiles/:userId/interests` endpoint is the place
- **Gender / `interested_in` are unread by the ranking.** Dating-specific
  filtering is its own decision and has not been made

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

### 5. Host coverage gaps

Measured against 2026 industry KPI guidance
([vFairs](https://www.vfairs.com/blog/event-kpis/),
[Bizzabo](https://www.bizzabo.com/blog/kpis-to-measure-event-success),
[InEvent](https://inevent.com/blog/others/25-key-metrics-for-measuring-event-success.html)).
The during-event story is the strong one and the differentiator; these are the
holes.

| Gap | Note |
|---|---|
| **Portfolio calendar** | Events are a table only — no month view across a run |
| **Venue: availability calendar** | "My venues" shows utilisation after the fact, not what is bookable |

### 6. Open questions

- **Counting staff needs staff identities.** `check_in_kind` derives staff from
  organisation membership at check-in, which is free and correct — and fires
  almost never, because it needs an org member to check in through the *attendee*
  app and crew have no accounts there. Production: 9 check-ins, zero staff. The
  UI no longer shows a permanent zero. Counting crew for real is a decision about
  giving them identities, and it has not been made.
- **Attendee demographics.** Deliberately thin for privacy. Decide explicitly
  rather than leave it implied.

### 7. Smaller, known

- **No client sends presence pings.** Endpoint and sweeper are live; the Expo app
  has to call `…/presence` for the loop to close
- **`events.current_capacity`** is written by nothing and read by nothing. Drop
  the column once production logs confirm it
- **`is_recurring`** is a dead flag still exposed to mobile as `isRecurring`
- **Phone + SMS OTP** is designed (pp. 1, 3) and unserved. A provider, a cost, a
  rate limit and a fraud surface OAuth does not have — a decision, not a task
- **Pre-event chat.** The design opens the room before the event; we open it on
  check-in. Additive, and needs a decision about what an empty room is for
- **`Create` and `Circles`** appear in the design's navigation with no data model
  behind them at all. Worth understanding before either repo builds anything
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

**Closing the feedback window per day.** It was listed here as a defect — "the
window closes 24 h after the *last* day, so day-one problems surface at the end
of the week". That was wrong twice over. Since 0.48.0 the sentiment sweeper
classifies messages within a minute, so day-one problems surface on day one. And
the post-event window is doing a **different job**: collecting reflective
feedback on the run as a whole, where someone may well look back and say what
they thought of day one. Per-day closure would remove that. The room stays open
24 h after the last day, deliberately.

**NPS from the existing ratings.** It was listed as a gap because NPS is the
number organisers report upward. It cannot be computed from what we collect:
NPS is defined on a **0–10** "how likely are you to recommend" question, and
`event_ratings.rating` is a **1–5** star. Mapping 5★→promoter and 1–3★→detractor
is what most tools quietly do, and it produces a number that is not NPS, gets
reported upward as though it were, and cannot be compared with anyone else's.

Real NPS needs a real 0–10 question — a schema column, an endpoint, and one more
thing asked of someone in an already-thin post-event flow. That is a product
decision about friction, not a metrics gap, and it has not been made. Average
rating and the star distribution already exist and are honest.

**Financial, sponsorship and pipeline metrics.** Every one assumes ticketing.
There is none, so there is no revenue to attribute.

---

## Done

### 0.56.0

- **The spec stops lying about the profile body**. Auditing the Expo app against
  this API turned up why 0.55.0's settings columns are still written by nothing:
  the spec's `UpdateProfileRequest` was a **hand-copied duplicate** of
  `updateProfileSchema` that had fallen six fields behind it — `goals`,
  `looking_for` and all four preference booleans. The one client reading
  `/api-docs` sent key names the route ignores.

  Fixed structurally rather than by re-copying: the spec now documents the
  schema the route validates with, so the two cannot diverge. `ProfileResponse`
  gained the same fields, which the GET has always returned and never declared.

  `openapi-coverage.test.ts` checked every *path* was documented, which is
  exactly why a missing *field* got through; it now checks this one too.

  Also: the four preference booleans no longer go to other users. The GET
  stripped `phone` and nothing else, so anyone could see whether you share your
  location.

### 0.55.0

- **Peer ratings and a trust signal** (#168), and four settings toggles that had
  persisted nowhere. The trust signal is never visible to an attendee — enforced
  by a test, because the person most likely to rate someone badly is the person
  who felt least safe with them.

### 0.54.0

- **Per-occurrence capacity is read** (#167). Occupancy measured every day of a
  run against the whole run's capacity, so a last day in a smaller room could be
  over its number invisibly. Plus NPS recorded as not-doable from 1–5 stars.

### 0.53.0

- **Connection metrics** (#166). Whether anyone actually met anyone — mutual
  connections, per attendee, and the share who made one, against the published
  benchmarks. Suppressed below 8 attendees, where a count names people rather
  than describing a room. Plus: the guest/staff split renders only when there is
  one, since in practice there is not.

### 0.52.0

- **Building occupancy** (#165). A venue running two events at once had two
  correct occupancy figures and no building total — the only number a fire
  officer asks for. Counts bodies, measured against the venue's own licensed
  capacity rather than the sum of the events', uncapped.

### 0.51.0

- **The RSVP waitlist** (#164). RSVP enforced no capacity at all — anyone could
  say "going" to a 100-capacity room without limit, which made `going` useless
  as a planning number. Full events now waitlist rather than refuse, and
  releasing a seat promotes whoever waited longest. Not a door policy: check-in
  still refuses nobody.

### 0.50.0

- **The match API** (#163). List, like with the mutual handshake, and per-event
  intent/reveal. Rarity measured against the room rather than the platform;
  staff excluded, people who left kept; nothing anywhere reveals who liked you
  first.

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
