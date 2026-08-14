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

## What this product is

**Not an event networking app. A way to approach someone at an event without
risking rejection.**

People are shy or scared to approach others at events, parties and concerts,
because they do not know whether the other person is willing to meet. Everything
here is mechanism for that one problem:

- **GPS check-in** — they are actually here, actually real, right now. No catfish.
- **Mutual like opens the conversation** — you never approach someone who has
  not already said yes. Rejection risk is zero.
- **Pseudonymity by default** — expressing interest costs nothing.
- **Group check-in** — nobody approaches alone.
- **Contextual room chat** — a reason to speak at all, about a thing you are
  both currently at.

**The organiser dashboard is not a product, it is the distribution channel.**
Organisers do not need to pay; they need to put a QR code on the screen, because
that is the only way to get **room-level liquidity**. Dating apps need liquidity
in a city. This needs it in a room, on a night, and it resets at the next event.
So build the minimum analytics that closes an organiser, not the best analytics
in the market. Two numbers nobody else has are enough: live occupancy against
licensed capacity, and whether anyone actually met anyone.

Full reasoning, competitive position and market data:
`~/.gstack/projects/Matryx-Social-Labs-Blendn-Admin/2026-08-08-design-approach-anxiety-thesis.md`

---

## Now

**Leaving a match.** Reviewed twice by `/plan-eng-review` and Codex; the second
pass found a live exploit path rather than a gap.

| # | What | State |
|---|---|---|
| T17 | `DELETE /conversations/:id` closes instead of destroying report evidence | **Done** (#197) |
| T19 | `maySeeIdentity` stops surviving a close | **Done** (#197) |
| T23 | The close reaches every door: REST, socket join, joined sockets, `openConversation`, the likes endpoint | **Done** (#197) |
| T22 | The reveal gate covers typing indicators and push titles | **Done** (#198) |
| T16 | Reveal state: seeding, propagation, reveal + ask endpoints | **Done** (#201) |
| T15 | Match / reveal-request / reveal notifications, with no names | **Done** (#202) |
| T3 | SSRF guard — nothing fetches a photo URL that is not ours | **Done** (#204) |
| T4 | The OAuth avatar is discarded; `User.image` mirrors the primary | **Done** (#204) |
| T7 | `User.image` clears when the last photo goes | **Done** (#204) |
| T10 | `photo_checks` + moderation on every new profile photo | **Done** (#204) |
| T24 | One atomic leave-and-report endpoint; gate the report route | **Done** (#200) |
| T18 | Block reaches the event room — history, socket, push, check-in ping | **Done** (#199) |
| T20 | Block closes the conversation and cancels both request directions | **Done** (#199) |

**Why T17 was urgent.** Either participant could hard-delete a conversation,
cascading every message. `message_reports.message_id` has no foreign key, so the
report survived while its evidence did not, and `resolveReport` then refused to
suspend anyone. The delete button belonged to whoever was most motivated to
erase the thread — the person being reported.

**T22 is a pre-condition, not a hotfix.** `socket-server.ts:431` emits the real
name as `userName` and the DM route puts it in the push title. Both are
consistent with today's real-name DMs; they become a leak the moment
pseudonymous DMs exist.


**After signup: retire onboarding, ask once, gate at the point of use.** Fifteen
PRs, reviewed by `/plan-eng-review` and by Codex. The app half is
`blendn/ROADMAP.md`; these are the server ones. "Server first" means **deployed**
— the app points at `staging-api.blendn.app`, so promotion to staging is part of
each PR's definition of done, not merging to `dev`.

| PR | What | State |
|---|---|---|
| 1 | `just_here` damping; `name` required, `age` accepted; `intent_default`/`gender`/`interested_in` writable | **Done** (#183) |
| 2 | Delete the roster completeness filter | **Done** (#184) |
| 3 | Reports reach a human; suspension reaches the phone | **Done** (#185) |
| 4 | Age policy: dating needs 18+, `events.min_age`, enforced at check-in | **Done** (#186) |
| 5 | `profiles.work_field` + `/work-fields`, on the card, suppressed in small rooms | **Done** (#187) |
| 6 | Dating compatibility — `orientation`, `deriveInterestedIn`, tag not filter | **Done** (#188) |
| 7 | Per-event preferences get their own table (`findFirst` is nondeterministic on a multi-day event) | **Done** (#189) |
| 8 | Email verification, gating chat from the *second* event | After app PR 13 |
| 9 | Seed: fix the review account's missing occurrence; `seed:room` for a 30-day event | **Done** (#190) |
| 15 | Scrub the new fields on account deletion | **Done** (#191) |

PRs 10–14 are app-side and tracked in `blendn/ROADMAP.md`.

**The follow-up owed is done (#207).** `event_check_ins.intent` and `.revealed`
were dead from 0.65.0 and are dropped. They were kept one release so a rollback
had somewhere to land — dropping a column in the same deploy that stops using it
means the previous build cannot run at all — and we are four releases past that,
so the rollback they protected no longer exists. Verified by removing them from
the schema and typechecking: Prisma generates its types from the schema, so a
surviving reader is a compile error rather than something grep might miss.

**Two sequencing constraints, both learned the hard way.** `age` cannot become
required until the app sends it — the first draft of this plan called PR 1 a
no-op while making it required, which would have 400'd every production signup.
And `reveal_by_default` seeding could not stop before the app had somewhere to
offer the name back — **resolved in 0.68.0** by sending `revealSuggestion` on
the check-in response, so the default is offered rather than discarded.


**The homepage nobody can see.** A device in Germany showed a full-screen *"No
events nearby"*. Every section of the attendee home screen is built and wired —
Nearby, "{City}'s Top", Upcoming, Interested, two heroes — and every one of them
is a `useMemo` over **one** query filtered to a 10 km box around device GPS. One
empty query blanks the whole page. Reviewed by `/plan-eng-review` and Codex; the
plan is `~/.claude/plans/sprightly-questing-aho.md`.

| PR | What | State |
|---|---|---|
| 0 | One city resolver: one fallback chain, language pinned in the proxy, `fenceCentre`/`eventCentre` in `lib/geofence.ts`, polygon centroid written back to the pin, address fields derived, backfill script | **Done** |
| 1 (API) | The browse contract: `city` param on `/events` and `/events/search`, `GET /events/cities`, radius removed from **both** code paths, distance-sort ceiling | **Done** |
| 1 (app) | Selected city persisted, header picker, section-level empty states, personal sections decoupled, realtime banner off the homepage | **Done** (blendn #90–#94) |
| 2 | The ambiguities: `bestPartiesItems` onto the real taxonomy, both "featured" heroes named honestly, `happeningNowItems` deleted, one distance helper | After 1 |

**Why PR 0 came first.** The city picker is only as good as the strings behind
it, and three screens were answering "which city is this pin in?" three
different ways — one of them skipping `village` and `municipality` and returning
the surrounding district instead, another not asking for English at all. Same
pin, different city, depending on which form the organiser opened.

**A live bug fell out of it.** Drawing a polygon never wrote back to
`latitude`/`longitude`, so an organiser could pin their office, trace a stadium
five kilometres away, and save both. Check-in was correct — it uses the fence —
while every distance the attendee app shows was measured from the office. The
fence now moves the pin, and `scripts/backfill-event-cities.ts` un-drifts the
rows that already exist.

**The age-cache hole is closed.** The plan had it as a separate follow-up, but
PR 1 edits the cache key itself, and adding `city` to a key that was missing
`viewerAge` would have papered over it. The list filters on
`min_age <= viewer.age`; the key mentioned neither age nor user, so an adult's
cached page could be served to a minor inside the 30-second TTL. Discovery only
— check-in always refused — but not something to leave standing while editing
that function. It is now `lib/events-cache-key.ts`, out of the route so it can
be tested, and `__tests__/events-cache-key.test.ts` asserts the property
directly: two requests that would compute different lists never share a key.

**Still open:** `app/api/geocode/route.ts` restricts geocoding to
`countrycodes=in`, which quietly makes the product India-only.


**Onboarding, and the age that goes stale underneath it.** The app has one
"about you" screen; the Figma *🕓 Updates* canvas has nine, with per-step save
and resume-on-quit. Building it means deciding what the server stores, and the
first thing that fell out was that **`profiles.age` has always been a snapshot
that decays**.

| PR | What | State |
|---|---|---|
| D2 (API) | `profiles.date_of_birth`, every age read derived through `ageFrom`, `dateOfBirth` accepted on profile PUT and returned by nothing | **Done** (#219, #220, #221) |
| D1 (app) | Token layer — Liquid Ember palette, Plus Jakarta Sans + Manrope | **Done** (blendn #97) |
| D1 (app) | Eight onboarding screens, per-step save, resume on quit | **Done** (blendn #98, #99) |
| D3 (app) | Route on stored progress, not `isNewAccount` | **Done** (blendn #98) |

**Why the birth date, and why now.** Nothing has ever rewritten `profiles.age`
after signup, so someone who joined at 17 was refused every 18+ event and the
dating tag a year later — permanently, with lying about their age as the only
way out. Ten read sites each did `profile.age` directly; they now go through
`ageFrom`, which prefers the date and falls back to the stored number for rows
written before the column existed.

**The date is write-only.** No route returns it, not even to its owner — it is a
standard security-question answer and half of an identity-theft pair, while the
age derived from it is neither. Closing that meant replacing the `isSelf` spread
in `GET /profiles/:userId`, which was a deny-list in a file whose own comment
rejects deny-lists; `date_of_birth` is simply the first column that made the
cost concrete. The dashboard keeps reading the stored `age` for the same reason
— deriving there would mean shipping birth dates to a browser.

**`onboarded` was already accepted and written by the API**; the missing writer
was the app, which had never sent it. That is why the dashboard funnel read
zero. The last onboarding screen now sends it (blendn #98).

**Two follow-ups, both found by asking staging rather than by reading the
diff.** #219 removed the birth date from `GET /profiles/:userId` and left it in
six other responses — five auth routes and both `include=profile` branches of
`GET /events` — because each spreads the whole profile row, and a spread is a
deny-list. #220 fixed six of the seven; the seventh survived a clean typecheck,
1178 passing tests and a test written for that exact leak, because `GET /events`
builds the envelope twice, byte-identical at different indent levels. #221
collapsed both onto one function and moved the tests up to the envelope.

The lesson worth keeping: a helper being correct is not the same as every caller
using it, and neither a typechecker nor a unit test on the helper can tell the
difference.

---

## Next

### The bio is a hole in the pseudonym

`profiles.bio` is free text and it renders **on the match card, beside the
pseudonym**. Nothing stops someone writing:

> "Hi I'm Sarah, IG @sarah_k, WhatsApp +91 98xxx"

Two separate failures in one field:

1. **It defeats the pseudonym.** The room withholds the name and the face, and
   then prints a paragraph the person wrote about themselves underneath. A name
   in the bio makes `maySeeIdentity` decorative.
2. **It moves the conversation off-platform.** A handle or a number in the bio
   routes people to WhatsApp or Instagram, where there is no moderation, no
   block, no report, and no record if something goes wrong. That is the
   failure mode that matters for safety, not just for engagement.

**Not being fixed yet — deliberately deferred until the screens are built**, so
the fix lands against the real surface rather than a guess at it. Noted here so
it cannot be forgotten.

When it is picked up, the pieces already exist:

- `lib/moderation/` runs keyword matching plus the OpenAI moderation API for
  chat. A bio is shorter than a chat backlog and can go through the same
  pipeline on write.
- A contact-detail detector is the second half: phone numbers, `@handles`,
  emails, URLs, and the usual obfuscations ("nine one eight...", "sarah at
  gmail dot com"). Deterministic, testable, and separate from the moderation
  call so it works when the API is down.

The open question is **reject or redact**. Rejecting on write teaches people
the rule at the moment they break it; redacting at render keeps the bio intact
for the people already allowed to see the person's identity. Probably both —
reject the obvious, redact for pseudonymous viewers — but that is a decision for
when the card is on screen.

Same rule should reach `occupation` and `education`, which are also free text
and also on the card.


### 1. Group-to-group matching — the mixing mechanic

**The single most important unbuilt thing, and it does not exist in any form.**

Group check-in is both the best idea in the product and the biggest threat to
it. It manufactures cold-start liquidity (one download brings three or four), it
matches how people actually attend (nobody goes to a concert alone), and the
group is the retention loop the event cannot be — the event is temporary, the
group persists.

But friends who arrive together talk to each other. That is what they already
do. If groups do not mix, this is a group chat for people standing next to each
other, with zero network value.

**Whatever forces mixing is the actual product.** Leading candidate: two groups
both opt in, and the app tells them where the other group is. Nobody approaches
alone, nobody is rejected alone.

Needs: a `groups` model scoped per event, group check-in, group-level like and
mutual handshake, and a ranking that scores group-to-group overlap rather than
summing pairs.

### 2. Interests reach the structured graph — ~~blocks matchmaking entirely~~ **wired, 2026-08-12**

**This item is closed, and the description below was already stale when read.**
It claimed `/profiles/:id/interests` had *zero call sites*, so `user_interests`
was empty and every match card returned no shared interests for everyone. That
was true when written and stopped being true in app #64: `about-you.tsx:246`
calls `addProfileInterests` at signup, and `edit-profile.tsx:268-269` calls both
add and remove. The structured graph is populated on every new account.

Kept rather than deleted because the failure it describes is the most expensive
kind this product has — ranking, IDF weighting and the overlap-naming card were
all *correct* and all fed by an empty table, so every test passed and every card
was blank. `app/api/health/route.ts:21` still carries a check for exactly that.

**What is genuinely left** is the taxonomy reshape, not the plumbing: 67 leaves
in a flat wall become 13 parents, optionally refined to leaves, with matching
made parent-aware so "Sports" and "IPL screening" stop scoring as strangers.
That is Stage 2 of the post-signup plan and it is app-led, with server-side
validation owed so an old client cannot keep writing bare leaves.

Mostly app-side, but ours to make easy: decide whether `/events/:id/checkins`
should carry interests so the client need not fan out, and whether
`profiles.interests` becomes display-only or is retired.

### 3. Moderation is core product, not compliance

Promoted after reading why Yik Yak actually died: not lack of context — context
was why it worked — but **harassment**. Racist threats, bomb and shooting threats
that triggered campus evacuations, two students arrested, a federal complaint
against a university for failing to protect students. Campuses banned it. It
relaunched in 2021 and the abuse returned immediately.

The risk here is not that nobody uses the room. It is that the room turns ugly
once, and that ends the product — especially in India, especially with women in
it. The differentiator versus Yik Yak is **accountability**: a GPS-verified human
behind every pseudonym, a moderation pipeline, and peer ratings routed to
moderation rather than displayed.

Treat the moderation surface as a first-class product area with its own budget.

---

## Next — supporting

### 4. Designed features still in scope

From `DESIGN_HANDOFF.md`. In the Figma, in neither repo. **Profile strength was
cut** — see *Validated — not doing*. None of these three is a wedge; do them when
they are cheap, not before the three items above.

| | API today | Work |
|---|---|---|
| **Search / Filter** | `/events/search` exists and is **never called**; `/events` filters on category, date, distance | Verify the surface covers the design — then it is app-only |
| **Map** | Events carry lat/lng; `/events` sorts by distance from a point | A viewport/bounding-box query — a map pans rather than searching a radius |
| **Notifications centre** | Push tokens exist; no record of what was sent | The largest — a table, a write on every push, list/read endpoints |

### 5. A coarse match band

Agreed in place of the design's `Match Percentage`: **Strong / Good / Some**,
never a raw number. Not thresholds on the score — that is IDF-weighted, so its
scale depends on how rare the room's interests are, and a fixed cut would mean
different things at a techno night and a conference. Proposed:

- **Strong** — two or more shared interests, at least one rare in that room
- **Good** — one or more shared
- **Some** — nothing shared, compatible intent

Degrades honestly: a room sharing nothing shows "Some", not a fabricated 34%.

### 6. Matchmaking — the surface

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

### 7. Host coverage gaps

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

### 8. Open questions

- **Counting staff needs staff identities.** `check_in_kind` derives staff from
  organisation membership at check-in, which is free and correct — and fires
  almost never, because it needs an org member to check in through the *attendee*
  app and crew have no accounts there. Production: 9 check-ins, zero staff. The
  UI no longer shows a permanent zero. Counting crew for real is a decision about
  giving them identities, and it has not been made.
- **Attendee demographics.** Deliberately thin for privacy. Decide explicitly
  rather than leave it implied.

### 8b. The metrics an investor asks for, and we cannot currently answer

**Nothing here is built. The capture for one of them now is.**

The dashboard has charts about *events* — attendance, capacity, ratings. It has
nothing about the **business**, so the questions a funding conversation opens
with cannot be answered from the product at all today:

| Metric | Why it is the one they ask | What it needs |
|---|---|---|
| **MAU / WAU / DAU** | The headline. Without it there is no denominator for anything else | An activity event per user per day. No table exists — `mobile_refresh_tokens` and `event_check_ins` are the closest proxies and both measure something narrower |
| **DAU/MAU ratio** ("stickiness") | For a social product this is the number that separates a habit from a novelty | Falls out of the above |
| **Retention curves** (D1 / D7 / D30) | Cohort survival is what tells you whether the thing works | Signup date, already have it, plus the activity table |
| **Activation rate** | signup → completed profile → first check-in. Where the funnel leaks | Timestamps exist across `profiles`, `user_interests`, `event_check_ins`; nothing joins them |
| **Check-ins per active user** | The core action. Blendn's equivalent of "orders per user" | Have the data, no rollup |
| **Match → conversation → reveal** | The product's actual promise, as a funnel | `matches`, `private_conversations`, reveal state all exist separately |
| **Organiser retention** | Do hosts run a second event? Supply-side health, and usually the harder side | `events.organizer_id` + dates |
| **City demand** | Where people opened the app and found nothing | **Capture built** — `city_demand`. No dashboard view yet |

**The one real dependency is an activity table.** Everything above except city
demand needs "this user was active on this day", and there is no such record —
so MAU today would have to be reverse-engineered from refresh-token rotations,
which measures *token lifetime* and not *use*. One narrow append-only table
(`user_id`, `day`, unique on the pair) answers MAU, WAU, DAU, stickiness and
every retention curve, and is cheap because it is one upsert per user per day.

**Do this before the numbers are needed, not when.** Retention is the metric you
cannot backfill: a D30 curve for a cohort requires having recorded their day-30,
and no amount of later work recovers a day that was never written down. The
sooner the table exists, the sooner the first honest curve is possible.

**City demand is the one to surface first** — it is already accumulating, it
needs a query rather than new capture, and *"forty people in Saarbrücken opened
this and found nothing"* is a slide on its own.

### 9. Smaller, known

- ~~**No client sends presence pings.**~~ **Stale — corrected 2026-08-12.** The
  app calls `usePresence(checkedInEventId)` from `app/(tabs)/events.tsx:278`, so
  the loop closes. What is *not* verified is that pings survive backgrounding
  and that the sweeper marks a departure from real pings rather than test ones —
  a device row, not a missing feature
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

**A profile strength meter.** In the Figma, and it contradicts the product. You
cannot ask someone to optimise a profile that is deliberately hidden until a
mutual like. The meter and the pseudonym are arguing about what the product is.

**Sessions, per-session ratings, Q&A and live polls.** Proposed after auditing
EventMobi's analytics page, withdrawn one turn later, and then checked against
what Indian organisers actually use. The check made the cut stronger, not weaker.

The relevant incumbent here is not Whova, it is **KonfHub** (Bengaluru), and it
already ships Q&A with AI question generation, live quizzing, session tracking,
analytics, automated badges and QR check-in — with **WhatsApp confirmation
messages available only to Indian organisers**. Pricing is **free for free
events and 1.75% per ticket for paid ones, no subscription, no setup fee**.

So this is not "compete with a ten-year-old incumbent". It is "compete with a
funded, localised incumbent that gives these away". India's event-tech startups
raised **$380M+ across 2023-24**, and domestic platforms are taking share from
global players specifically on regional language support and UPI payment flows.
Feature parity is the worst possible ground to fight on.

What KonfHub does **not** have is the thing we already built: live occupancy
against licensed capacity, building occupancy across concurrent events, crowd
sentiment read from the room's own chat, and whether anyone actually met anyone.
Lead with those; do not chase the rest.

**Exhibitor lead capture, zone dwell time, CE credits.** Still not doing them,
but the India check turned up a real distinction worth recording, because the
first version of this entry was imprecise.

There *is* a documented, unserved pain here: Indian exhibitor management is
"held together by spreadsheets, shared drives, PDF manuals, email chains and a
whole lot of chasing", with organisers juggling 15+ Excel sheets and 8 WhatsApp
groups for a single event. That is a genuine status-quo answer, and better
evidence of pain than anything on the attendee side.

But it is **exhibitor operations**, not exhibitor **analytics**. Zone dwell time
does not fix fifteen spreadsheets. Cvent LeadCapture and ExpoPlatform already
serve the measurement half globally. So the gap is real and it is a different
product from the one we would have built.

Worth keeping as a **future revenue hypothesis**: if attendee engagement
features are commoditised to free in India (KonfHub proves they are), then the
money in Indian events is in operations and exhibitors, not in engagement. That
is an argument for never charging organisers and using them purely as
distribution, which is what this roadmap now assumes.

**Gamification** — top players, challenges, point totals. An organiser
engagement toy. Moves no part of the approach-anxiety loop.

**Banner ad impressions, clicks and conversion.** No ad surface, and putting one
into a pseudonymous room is off-brand for the one thing the product is trying to
protect.

**Video session analytics.** No video.


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

### 0.68.0

- **Check-in stops naming people implicitly** (#194) — `revealed` is always
  false on create, and `reveal_by_default` comes back as `revealSuggestion` for
  the app to offer as a tap.

- **`remember` split into `rememberIntent` and `rememberReveal`** (#194). One
  flag wrote both defaults while the UI labelled it as reveal only.

### 0.67.0

- **Account deletion scrubs the matching inputs** (#191) — gender, orientation,
  interested_in, intent_default, reveal_by_default, work_field, the structured
  interests and every per-event preference row. Guarded by a test that reads the
  schema, so the next column added to `profiles` cannot survive deletion
  quietly.

### 0.66.0

- **App Review could not check in to their own demo event** (#190). The seed
  wrote the `events` row directly and skipped occurrences, so check-in reported
  "Event has already ended" on an event starting tomorrow.

- **`npm run seed:room`** (#190) — a thirty-day event with twenty-five people
  shaped to make each matching behaviour visible. Staging went from
  `matching: no_signal` to `rankableShare: 0.8`.

### 0.65.0

- **`event_match_preferences`** (#189) — one row per person per event, replacing
  two columns on `event_check_ins` that became ambiguous the day check-ins went
  per-occurrence. Both readers used an unordered `findFirst`, so on a multi-day
  event your intent and reveal state were whichever row came back first.

- **The match list stopped listing a three-day attendee three times** (#189),
  and `insideNow` now means their most recent day rather than an arbitrary one.

### 0.64.0

- **Dating compatibility, as a tag filter** (#188). `matches.ts` never read
  gender, so "Both open to dating" appeared between people who were not a match.
  The tag is dropped, never the person — everyone stays in the list and still
  matches on interests and networking, and a card claiming a dating match has
  had compatibility checked, so it never states anyone's gender.

- **`profiles.orientation`** (#188), stored beside `interested_in` rather than
  replacing it, because the label only sometimes implies the set. Ambiguous
  pairs return null and are asked directly; client-supplied `interested_in`
  always wins over derivation.

### 0.63.0

- **`profiles.work_field`** (#187) — eighteen server-owned buckets, served at
  `GET /work-fields` so no client holds its own copy and no build goes stale.
  Outside the identity gate, because a coarse bucket is an attribute where an
  employer is an address. Suppressed on cards in rooms under eight people, where
  four attributes name one person; still ranked on there, since the score never
  leaves the server.

### 0.62.0

- **Dating requires 18, on both write paths** (#186). `profiles.age` accepted 13
  and nothing connected that to anything — a 14-year-old could tick dating and
  land in the same pool as adults. The rule is in `lib/age.ts` rather than
  inline because `age` is nullable and `null < 18` is `true`, so the obvious
  check admits exactly the case it was meant to stop.

- **`events.min_age`** (#186), set by the organiser, enforced at check-in with
  its own error code, and used to hide the event from anyone whose stated age is
  below it. An unknown age is refused at the door but not hidden from in the
  feed — OAuth accounts have no age yet, and failing closed there would empty
  their listing.

### 0.61.0

- **Reports reach a human** (#185). `user_reports` and `message_reports` were
  written by two mobile routes and read by nothing in either repo. Now a queue
  at `/dashboard/moderation/reports` with dismiss / remove message / suspend,
  each writing `audit_logs`. Remove is group-rooms-only: `private_messages` has
  no `deleted_at`, and the lever against a DM is the person, not the message.

- **Suspension reaches the phone** (#185). `users.suspended_at` was read only by
  `socket-ops-auth.ts`, so suspending an attendee changed nothing about the app
  they were in. Checked now wherever a mobile token is issued, with refresh
  tokens revoked at the moment of suspension.

- **`intent_default`, `gender`, `interested_in` writable; `age` accepted at
  signup; the `just_here` damping no longer punishes the honest answer** (#183).

- **The roster stops filtering on fields it does not serve** (#184).

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
