# Changelog

All notable changes to Blendn Admin are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.46.0] - 2026-08-07

### Security

- **The attendee list handed out real names and photos.** Every other view of a
  room — group chat, the participants list, the socket payloads, the dashboard —
  carefully returned `chat_group_members.anonymous_name`. `GET
  /events/:eventId/checkins` returned `User.name` and `User.image` to any
  authenticated caller, so the pseudonymity was readable straight out of the
  network tab. It is the same defect `__tests__/chat-identity.test.ts` was
  written for on the dashboard side, living on the mobile side the whole time.
  It now returns the room pseudonym and no photo.

- **`POST /conversations` opened a DM from two user ids and nothing else** — no
  accepted message request, no block check. DMs are meant to be gated behind a
  request the other person accepted; the gate existed only on the screen that
  happened to use it.

- **Responding "block" did not block.** It set the request's status to `blocked`
  and wrote no `blocked_users` row, so the only thing enforcing blocks saw
  nothing and the sender could simply send again.

- **Blocks were checked in one direction.** The DM send path asked only whether
  the recipient had blocked the sender, so someone who had blocked another person
  could still message them — and keep receiving replies from someone they had
  chosen not to hear from. Now checked both ways everywhere, including on the
  public profile, which blocked users could still read.

- **Message requests had no co-presence requirement.** Any authenticated caller
  could request any user id they could guess or scrape. Now both people must have
  checked in to the same event — ever, not currently, because messaging someone
  the morning after is the ordinary case. An RSVP does not count.

- **`goals` and `looking_for` survived account deletion**, quietly the most
  sensitive pair on the profile.

### Fixed

- **One pair of people could get two conversation rows.** `POST /conversations`
  sorted the two ids before writing; the message-request accept handler wrote
  them in request order. `@@unique([user1_id, user2_id])` cannot tell that
  (a, b) and (b, a) are the same pair. Both paths now go through
  `lib/conversations.ts`, where sorting is not a detail anyone has to remember.

## [0.45.0] - 2026-08-07

### Added

- **The attendance panel and the occupancy hero.** The last part of the check-in
  reframing that had data but no UI. Occupancy shows the guest/staff split beside
  the headline rather than folded into it — "142 in the room, 138 guests, 4
  staff" answers two questions the same person asks ten seconds apart. Attendance
  degrades to one honest number for a single-day event, because most events are
  one evening and a five-column chart rendering a single bar is worse than a
  figure. Cancelled days keep their slot, hatched, since dropping them leaves an
  unexplained gap in the dates and a zero bar reads as a day nobody came to.

- **A test that walks the import graph from `server.ts`.** `build:server`
  compiles with plain `tsc`, which resolves the `@/` alias for typechecking and
  then emits it verbatim into the `require()` — so the build goes green, CI
  passes, and the container dies on boot with `MODULE_NOT_FOUND`. Every layer
  that could catch this is blind to it. The test names the chain that made a file
  reachable, not just the file.

### Fixed

- **Two screens disagreed about how full a room was.** `lib/live-snapshot.ts`
  computed fill as `min(100, inside / capacity)` — capped, and against
  staff-inclusive occupancy — while `lib/occupancy.ts` computed guests against
  capacity, uncapped, and reported `overCapacity`. A room at 88 guests and 4 crew
  against a stated 80 read "100%, full" on the live tab and "110%, 8 over" on the
  occupancy panel. The cap was the worse half: it did not round a number down, it
  made an over-capacity room unrepresentable — the one situation the live screen
  exists to surface. `occupancyFrom()` is now the only implementation.

- **`/` was a second marketing pitch** shown to people who already have an
  account and are trying to sign in. The 141-line page is gone; `/` resolves in
  middleware to `/dashboard` when signed in and `/login` otherwise, and travels
  with them under the host split so the bare domain is not also the slowest way
  in.

- **Dashboard screens measured the window, not the content column.** The sidebar
  is 16rem and collapsible, so `lg:grid-cols-2` fired at 1024px of window whether
  or not 256px of it was sidebar. 21 breakpoints across five screens moved to
  `@container/main`, with a test to stop the drift returning.

### Documentation

- `DASHBOARD_HOST` and `API_HOST` documented in `.env.example` and
  `DEPLOYMENT.md`, including the ordering constraint that actually bites: Railway
  serves its `*.up.railway.app` wildcard until Let's Encrypt issues, so turning
  the split on before the certificate lands redirects the dashboard to a host the
  browser refuses — unreachable on both names.

- `docs/ROADMAP.md` restructured into a working ledger — Now, Next,
  Validated-not-doing, Done — with the rule that nothing ships without it moving.

## [0.44.1] - 2026-08-06

### Fixed

- **Humans are redirected, machines are rejected.** A person on
  `api.blendn.app/dashboard/leads?lead=…` followed a link, very possibly one of
  our own lead-notification emails, which deep-link to `NEXTAUTH_URL` and were
  already sent. A 404 would have broken every one of them in every inbox. A
  mobile client on the dashboard host is a different thing — nothing linked it
  there, it is misconfigured, and a redirect would hide that until something
  subtler broke.

## [0.44.0] - 2026-08-06

### Added

- **`dashboard.blendn.app` as a second domain on the same service.** Organisers
  were logging in at a URL called `api`. The split is routing, not
  infrastructure: one deployment, one Socket.io, one Prisma client. Both
  `DASHBOARD_HOST` and `API_HOST` must be set or the split is skipped entirely,
  so local development and any single-host environment are unaffected.

## [0.43.0] - 2026-08-07

### Added

- **Per-day attendance: new versus returning, and retention.** `occurrence_id`
  made this askable for the first time — before it a five-day conference held
  one row per attendee and "who came on Wednesday" had no answer. For a
  conference the retention figure is the question: a run drawing 400 on Monday
  and 120 on Wednesday has a problem the total hides completely. Staff are
  excluded, since they attend every day by definition and would swamp
  "returning".

- **Nominatim is proxied server-side.** Three browser call sites hit it with no
  `User-Agent`, against OSM's usage policy. Not hypothetical — Overpass returned
  `406` to exactly that request shape while backfilling venue data, and
  Nominatim is the only geocoder this product has.

- **`dashboard.blendn.app`.** Organisers were logging in at a URL called `api`.
  Two names, one Railway service; each surface refuses the other's host when
  both are configured, and everything serves everywhere when they are not.

## [0.42.0] - 2026-08-07

### Added

- **Presence.** Check-in was a one-shot gate: it proved you were at the venue
  once and nothing revisited the claim, so anyone who left without checking out
  stayed counted for ever. The client now pings while checked in; leaving the
  fence starts a grace period, then a prompt, then a checkout.

  **Silence is not departure.** No ping can mean a backgrounded app, a basement,
  a dead battery, a revoked permission. Silence alone does nothing; silence
  *after* a confirmed out-of-fence reading lets the clock run.

  The sweeper **refuses to check out more than a quarter of a room at once** and
  raises an alert instead. A venue whose wifi dies produces readings identical to
  everyone leaving, and the organiser is better served by "this count is
  unreliable" than by a confidently wrong number.

  Staff are never swept out mid-event.

### Fixed

- The first version of the silence rule short-circuited on any missing ping, and
  the sweeper never carries one — so the grace and prompt clocks were
  unreachable and nobody would ever have been checked out. Caught by the
  integration tests before release.

## [0.41.0] - 2026-08-07

### Changed

- **Occupancy is counted, never stored.** `events.current_capacity` was one
  counter doing three contradictory jobs — what the room holds, who is in it,
  and who came. Two production bugs came from it in a single day. `lib/live-snapshot.ts`
  had already abandoned it and counted rows directly; the chatrooms screen still
  summed the column, so **two screens answered the same question with different
  numbers**. There is now a test asserting they agree.

- **Check-in no longer refuses at capacity.** The geofence covers the pavement,
  so a 100-capacity venue with 100 inside and 20 queuing has 120 people
  legitimately within it. Refusing the hundred-and-first denied them the
  chatroom and erased them from attendance. Over-capacity is now a **signal**,
  which is the crowd-safety event this product is positioned around and was
  previously impossible to observe.

- **Staff are told apart from guests**, with no client change. The server
  decides from organisation membership — an organiser at someone else's event is
  correctly a guest, which a role check would get wrong. Occupancy counts staff
  because fire safety counts bodies; attendance and turn-up do not.

### Added

- `performCheckout` — one path for the manual route, the event switch, and the
  sweeper. Three copies of "check someone out" is how they drift.
- **The check-in route finally has an integration test.** It is the mechanic the
  whole product rests on and no test had ever invoked it; 2 of 74 route files
  had coverage, which is how a capacity bug shipped twice in one day.

## [0.40.0] - 2026-08-07

### Added

- **Multi-day events.** `event_check_ins` carried `UNIQUE(event_id, user_id)`,
  so a five-day conference could hold exactly one row per attendee and the
  upsert overwrote Monday's timestamp with Tuesday's. `event_occurrences` — every
  event has at least one. A club night running past midnight stays **one**
  occurrence; days are cut in the event's own timezone.

- Retired `recurring_events`: zero rows, zero reads, an abandoned earlier attempt
  at the same concept.

### Fixed

- Two latent bugs the change introduced, found by audit rather than failure:
  capacity counted check-ins rather than people, and shortening a run silently
  destroyed attendance. A dropped day with attendance is now cancelled, not
  deleted.

## [0.39.0] - 2026-08-07

### Changed

- **The event overview is an overview.** It rendered the staged editor, so
  opening an event to see how it was doing put you in a seven-stage form. One
  hero metric, changing with lifecycle state; the editor moved to `/edit`.
  `?tab=` kept, since bookmarks and notification deep links use it.

## [0.36.0] – [0.38.1] - 2026-08-06/07

### Added

- **Leads.** `POST /api/leads` ingests demo requests from the organiser landing
  page, with an admin inbox, CSV export and a PII retention script. Three
  departures from the contract, each because the spec could not do what it said:
  rate limits key on the body (every lead arrives from one Vercel address);
  the per-email cap strips plus-addressing; and idempotency is scoped to *open*
  leads via a nullable unique column, because a partial index would exist in
  production and be missing in CI.
- Notifications by Slack or email, both optional, both free.
- **Venue owners can dispute an event's link.** `venue_link_status: "disputed"`
  had been in the schema since v0.18.0 written by nothing.

### Fixed

- **The dashboard root was throwing for every signed-in user.** `DataTable`
  gained `"use client"` in the table-system PR while five call sites had been
  passing `render` functions since the design rebuild. No new code was wrong — a
  directive moved a boundary underneath code that already existed. `tsc` cannot
  see it, `next build` never renders `force-dynamic` pages, and no test rendered
  a route. `__tests__/rsc-boundary.test.ts` now asserts the invariant.
- The venue-owner screen grouped by typed venue name, so two spellings read as
  two venues.

## [0.29.0] – [0.35.1] - 2026-08-06

### Added

- **Geofencing.** `check_in_radius` conflated three quantities: the venue's
  size, the organiser's tolerance, and slack for bad GPS. Separated into extent,
  buffer and a per-check-in accuracy allowance. Polygon fences with one-click
  OpenStreetMap footprint import.
- **Venues became real.** The table had a detail page, a search index and a
  permission resolver reading it, and nothing had ever written a row. Create,
  claim, dispute, 35 venue types, and inheritance into the event form.

### Fixed

- **A real ISL match carried a 100 km check-in radius** — most of Bengaluru.
  Five events were over the cap; all were past events, so nothing live was
  affected.

## [0.15.0] - 2026-08-05

### Security

- **Rate limiting now covers the mutating API.** 22 mobile routes had none at
  all, including `users/[id]/block`, both report endpoints,
  `uploads/presigned-url`, and `events/[eventId]/announce` — which sends a push
  notification to every attendee of an event. One is left deliberately
  unlimited: `auth/signout`, where refusing the request leaves a session the
  user asked to end.

- **Counters live in Redis when `REDIS_URL` is set.** They were held in a
  process-local `Map`, so every limit was per-replica: 30/min silently became
  30/min *per instance*, and each replica added made every limit weaker.

  With no Redis, or if Redis is unreachable, it degrades to the in-process
  counter rather than failing open or failing closed. Failing open would let an
  attacker disable every limit in the product by taking one dependency down;
  failing closed would turn a Redis blip into an outage.

### Changed

- `rateLimit()` is now async, since the counter is remote. All call sites
  updated.
- Authenticated routes are keyed on the **user**, not the IP. For an
  authenticated endpoint the abuse case is one account misbehaving, and IP
  keying is actively wrong there — everyone behind one NAT shares a bucket
  while an attacker rotates address.
- Limits are named policies (`broadcast`, `upload`, `safety`, `write`,
  `heavy`) rather than numbers scattered across routes. `safety` is
  deliberately loose: rate limiting a report or a block is a trade-off against
  someone in trouble, so it sits where only automation notices it.

## [0.14.0] - 2026-08-05

### Changed

- **Chatrooms close themselves.** The archive job needed an external cron nobody
  had scheduled. It now runs inside the server process — once on boot, then
  every 15 minutes — beside the existing sponsored-message scheduler.

  Deliberately a periodic sweep rather than a timer per event. The write gate
  already refuses posts to an expired room on the strength of the event's own
  `end_time`, so this job never was what stops anyone typing; it tidies state.
  Lateness is therefore unobservable, and per-event timers would buy that
  invisible precision at the cost of four kinds of bookkeeping — reschedule on
  edit, cancel on delete, rehydrate on boot, dedupe across replicas.

  `/api/cron/archive-chats` remains as a manual trigger and calls the same
  function, so there is one implementation rather than two that can drift.

### Added

- `includePast` documented on the events list, and the organiser schema no
  longer advertises an email — both drifted when the behaviour changed in
  v0.13.0.
- Spec entries for five previously **undocumented** mobile endpoints: Apple
  sign-in, report a message, report a user, list blocked users, and delete your
  own account. Three of those are the safety surface, which is the last thing a
  client developer should have to reverse-engineer from source.
- `__tests__/openapi-coverage.test.ts` asserts spec ↔ route agreement in both
  directions. It found those five. It cannot prove response *shapes* match —
  that needs contract tests against real handlers — so a green run means the
  spec and the routes describe the same set of endpoints, nothing stronger.

## [0.13.0] - 2026-08-05

### Fixed

- **Event chatrooms never closed.** A membership row was a permanent licence to
  write: people were still posting into rooms for events that finished months
  earlier. Two causes, both now removed.

  There were two write paths with two different gates. `events/[id]/chat`
  rejected anything not `active`; `chat/groups/[id]/messages` rejected only
  `locked`, so an **archived room stayed writable**. Both now call one rule,
  `chatWindowState` in `lib/chat-window.ts`, so they cannot fork again.

  Archiving was also opportunistic — it piggybacked on a mobile chat-list
  request, so a room nobody opened stayed `active` indefinitely. It is now a
  cron (`/api/cron/archive-chats`) that runs whether or not anyone opens the
  app, and marks members `left`.

  The write gate deliberately does **not** depend on that job having run: it
  compares against the event's own `end_time`, so a room the job has not
  reached yet is still closed. Jobs are late, get stuck, or have never run for
  a given row.

- **The mobile events feed served only finished events.** There was no time
  filter at all — on production that meant all ten events, every one already
  over, presented as things to go to. Discovery now excludes ended events;
  `includePast=true` still returns them for history screens.

- **The organiser's email address** was returned by `GET /api/mobile/events/[id]`.
  The list endpoint never included it; only the detail endpoint did.

### Notes

- Members are marked `left`, not deleted. `anonymous_name` lives on the
  membership row and every historical message resolves its pseudonym through
  it — deleting the rows would strip names off the whole transcript, which
  anonymises nobody and breaks the feedback digest. Banned members keep that
  status, since a ban is a moderation record that should outlive the room.

## [0.12.1] - 2026-08-05

### Fixed

- **v0.12.0 failed its healthcheck on staging and never deployed.** `build:server`
  compiles `server.ts` with plain `tsc`, which resolves the `@/` path alias for
  typechecking and then emits it verbatim into the `require()`. Two new files in
  the socket graph used `@/lib/db`, so the build went green and the container
  died on boot with `MODULE_NOT_FOUND`. Everything reachable from `server.ts`
  now uses relative imports, with a comment saying why so it does not get
  "tidied" back.
- CI now loads the compiled server graph after building. Nothing connects —
  `lib/db.ts` builds its client lazily behind a Proxy — so it is a pure module
  resolution check, and it is the one thing that would have caught this before
  the deploy rather than after.

## [0.12.0] - 2026-08-05

### Added

- **Live tab on event detail.** The dashboard was blind to an event while it was
  happening — everything was either forward-looking pacing or a next-day
  digest. Shows who is inside against capacity, arrival rate against this
  event's own median, check-outs, chat pace, active chatters, open flags, the
  rolling mood split, and complaints by category. Updates over the socket
  channel; pre-event, live and post-event states are all designed.
- Alerts rendered from the same aggregates, with an explicit resting state
  saying that alerts combine chat and check-in signal rather than leaving a
  blank panel.
- `ArrivalCurve` and `CategoryBars` charts.

### Changed

- **Event detail is a tab host, gated on operational access rather than
  editing.** A venue owner can now open an event held in their building — its
  live view, guest list and chatroom — with the editor reserved for whoever
  runs it, and a note saying so rather than a silently missing button.
- Tabs are lifecycle-aware: Live only while the event runs, Feedback only after
  it ends and while the chat window is open. A tab that is permanently empty
  teaches people to stop clicking tabs.
- **Chatrooms is a triage list.** It listed live events only, so a room full of
  post-event feedback — the entire point of the feedback window — was
  unreachable unless you already knew the event. It now covers any room whose
  chat is open, live or in its feedback window.

### Fixed

- The Live tab was offered to users without operational access. Live data is
  attendance and chat, not a public summary, and the socket room behind it
  gates on exactly that permission — a tab list offering something the server
  will deny is its own bug. Caught by a test before it shipped.

## [0.11.0] - 2026-08-05

### Added

- **Dashboard clients can hold a socket.** The handshake accepted mobile JWTs
  only, so a NextAuth session could not connect at all — which is why the
  "live" chat feed is a 5-second poll. A second, strictly separate scheme reads
  the session cookie; the mobile verify runs first and, when it succeeds,
  nothing new executes.
- **`event:{id}:ops` room** carrying a live aggregate snapshot every 5s:
  inside now, arrival rate against this event's own median, check-outs,
  messages/min, active chatters, open flags, sentiment split, and negative
  messages by category.
- **Live alerts** derived from those aggregates. The rules that matter combine
  chat and check-in signal, because neither means much alone — a check-in spike
  is a popular act arriving, and grumbling about a queue is routine; together
  they are a door that has stopped moving.
- Optional `@socket.io/redis-adapter`, attached when `REDIS_URL` is set.

### Notes

- **The ops room carries aggregates only.** No attendee row, user id, name or
  message text crosses it. Event chat is pseudonymous and that has to hold on a
  long-lived channel nobody inspects, not just in the REST payload. A test
  asserts the snapshot has no field that could name anyone.
- The socket role is re-read from the database rather than trusted from the
  session token. A NextAuth JWT is signed so it cannot be forged, but it can be
  stale — and for a socket that outlives the request that opened it, a
  demotion or suspension issued mid-session would otherwise never take effect.
- Snapshot timers run per event and only while someone is watching, stopping
  when the last watcher leaves.
- **Do not raise the replica count until `REDIS_URL` is set.** Without it the
  default in-memory adapter stands, which is correct at one replica and wrong
  at several. The adapter path is unexercised until a Redis instance exists.

## [0.10.0] - 2026-08-05

### Added

- **Feedback classification pipeline.** Post-event chat messages are labelled
  with a sentiment *and* an issue category, because sentiment alone is not
  actionable — "12 negative" tells an organiser nothing, "9 of 12 are the bar
  queue" tells them to open another bar.

  The category set is drawn from live-event operations research rather than
  invented: `entry_queue`, `crowding`, `facilities`, `sound_av`,
  `staff_service`, `food_drink`, `wayfinding`, `technical`, `safety_conduct`,
  `other`. Crowd mismanagement is the largest single cause of venue incidents,
  with queueing, wayfinding and technical failures the other recurring themes.

- Two-tier classification. A free lexicon pass labels only what is unambiguous
  and escalates everything else to a batched LLM call — most event chat is
  neutral logistics, and paying to read those is the waste worth removing. At
  ~500 messages an hour that is single-digit API calls per hour per event.

- `event_feedback` table. Separate from `chat_messages` because only a small
  subset of messages are ever classified and that table is the hot one.

### Notes

- `safety_conduct` escalates to moderation regardless of sentiment: a calmly
  worded report of harassment is still a report, and routing on tone would
  deprioritise it for being composed.
- The mobile client's on-device label is **advisory only and never reaches this
  pipeline**. A patched client could otherwise suppress a negative or
  manufacture an alert that pushes to the organiser's phone.
- With no API key or during an outage, messages the lexicon declined come back
  at low confidence marked `lexicon` — never a confident wrong label. The UI is
  expected to render low confidence differently, which is why `confidence` and
  `source` are stored rather than just the label.

## [0.9.0] - 2026-08-05

### Added

- **Venues are a real record.** Until now a venue was a nullable free-text
  string on an event and a "venue owner" was a role whose events happened to
  carry venue names, so Byg Brewski could not exist as a thing. `venues` has an
  optional owner — null means unclaimed — and `events.venue_id` links to it.
  `events.venue_name` is deliberately kept: most events are at places that are
  not on the platform, so linkage is optional everywhere.
- Account suspension columns on `User`. Suspension, not deletion, is how a host
  is removed — deleting one cascades their events, every check-in and every chat
  message, destroying other people's history to punish one person.

### Changed

- **Authorization is relationship-shaped, not role-shaped.** `canManageEvent`
  and `canModerateChat` are replaced by a single `eventPermissions(actor, event)`
  resolver returning `{ canEdit, canOperate }`, derived from two axes:
  `organizer_id` (who runs it) and `venue.owner_id` (whose building it is in).

  A venue owner now gets the operational bucket — chat, moderation, the guest
  list — for events at their venue, and both buckets for events they run
  themselves. The event stays un-editable by them, because it is not theirs to
  change.

### Fixed

- **Venue owners were locked out of every chatroom.** `canManageEvent` denied
  `venue_owner` unconditionally while `canModerateChat` allowed them; the nav
  and the chatrooms list said yes and the messaging page said no, so opening any
  room redirected straight back out. The two predicates cannot disagree now
  because there is only one.
- The chatrooms list scoped on `organizer_id` alone, so a venue owner saw
  nothing there even for events in their own building.

## [0.8.1] - 2026-08-05

### Security

- Event chat is pseudonymous — attendees get an `anonymous_name` on check-in so
  they can give honest feedback without the organiser knowing who said it. The
  dashboard UI honoured that, but `GET /api/events/[id]/chat/messages` shipped
  every attendee's real **name and email** in the JSON to any organiser or venue
  owner regardless, readable straight out of the browser's network tab. The
  anonymity was cosmetic.

  Real identity is now app_admin only. Hosts get the pseudonym and the user id,
  which they need to ban or mute, and nothing that names a person. The fields
  are *absent* rather than null so reading `user.name` yields undefined instead
  of a convincing blank, and the client type marks them optional so rendering
  one without checking the role fails to typecheck.

## [0.8.0] - 2026-08-05

### Changed

- **Dashboard rebuilt from the Claude Design system.** The three roles now get
  genuinely different screens rather than one layout with strings swapped, and
  the forward-looking question leads each of them.
  - `organizer` opens on the next event's fill against capacity in 40px type,
    with an RSVP pacing curve plotted against days-to-event and the capacity
    line drawn in — the question the old dashboard could not answer at all.
  - `app_admin` opens on a moderation attention strip, then signups vs active
    users on one axis, where the gap between the lines is the vanity.
  - `venue_owner` gets per-venue rows, a day x slot utilisation heatmap, and
    per-venue rating distributions. It previously received the organiser's
    dashboard with two strings changed.
- Navigation is per role: Moderation / Users / Organisers / Venue owners for
  admins, Attendees for organisers, My venues for venue owners. Nav items are
  single-line — the old two-line blocks with bordered icon tiles would have run
  taller than the viewport at nine items.
- Hierarchy now comes from type rather than boxes. The old overview put eleven
  elements in identical bordered cards, so nothing read as primary.

### Added

- **Platform-wide moderation queue** at `/dashboard/moderation`. `moderation_flags`
  is a core table and the only way to see any of it was to open one event's
  messaging page at a time. Ordered oldest-first because age is the SLA; keep
  and remove decisions write to `audit_logs`; the sidebar badge is fetched in
  the server layout so it is correct on first paint.
- Attendees screen for organisers (repeat attendance, no-shows) and My venues
  for venue owners (one section per venue, never blended).
- `docs/DASHBOARD_DATA_GAPS.md` — every metric was mapped to a real query before
  being built; this records the ones that could not be produced honestly, what
  shipped instead, and what it would take to close them.

### Fixed

- Funnel stages were four independently-counted populations drawn as a funnel.
  Staging had 7 onboarded and 10 RSVP'd, so the chart widened downward. Each
  stage now filters on the one above it, and the integration suite asserts the
  sequence is non-increasing.

### Removed

- CSV export. The redesign has no export affordance, so the menu was removed
  rather than left orphaned against a report shape that no longer exists. See
  the note in `docs/DASHBOARD_DATA_GAPS.md` if it should come back.
- Four dead files (`section-cards`, `chart-area-interactive`, duplicated under
  both `app/dashboard/` and `components/`), referenced by nothing.

## [0.7.0] - 2026-08-05

### Added

- Forward-looking reporting on the dashboard overview. Every figure on it was
  trailing 30-day, so a host could see how last month went but nothing about the
  event running on Thursday. `Upcoming events` shows committed RSVPs against
  capacity for each published event that has not started, coloured by how far
  short it is.
- A second chart per role, chosen for what that role actually decides on:
  moderation queue by review state for `app_admin`, rating spread for
  `organizer`, events by venue for `venue_owner`.
- Moderation backlog for `app_admin` — pending flag count, affected chatrooms,
  and flags per 1,000 messages. `moderation_flags` is a core table and the only
  way to see any of it was to open one event's messaging page at a time.
- Turn-up rate for hosts: committed RSVPs against actual check-ins on past
  events. The remainder is the no-show rate, which is what decides catering and
  whether to overbook.
- `scripts/create-dashboard-user.ts` to create or reset a dashboard login. The
  password is generated rather than taken as an argument, so it never lands in
  shell history or the process list.
- Both new sections are included in the CSV export bundles.

## [0.6.0] - 2026-08-05

### Added

- Brand design system. Colour, type, and layout now follow the Blend'n Brand
  Guideline instead of shadcn's defaults; documented in `docs/DESIGN_SYSTEM.md`.
  Every theme token was previously `oklch(L 0 0)` — zero chroma, pure greyscale —
  so the only brand element on screen was the logo image.
- Satoshi as the interface typeface, self-hosted (`app/fonts/`) so the first
  render does not block on Fontshare's CDN.
- `--success` token for positive deltas. The metric arrows used `--chart-1`,
  which in the dark theme rendered a positive change in blue against a red
  negative.
- Indexes on ten foreign keys that had none, and an integration test asserting
  the class of bug is gone rather than the ten instances.

### Fixed

- Two of the four spotlight cards rendered twice on the overview — once in the
  hero rail and again in the section below. The hero now carries the export
  action, which belongs at page level anyway.
- The page header rendered the description sentence as the `h1` and the page
  name as a 0.68rem eyebrow, putting the wrong string in the document's only
  landmark heading. There were also two `h1`s on the overview.
- Funnel stages with a value of zero drew a bar a tenth as wide as the largest
  stage, so a funnel that dropped to nothing still looked like it converted.
- Venue owners could not reach Chatrooms. `canModerateChat` and the messaging
  page's `canManageEvent` gate had always allowed it; the nav list and the
  chatrooms index were the only things saying no.
- The "top performers" table drew from the 24 most *recent* events and then
  ranked them by traction, so a host with more than 24 events got a recency
  window presented as a whole-portfolio leaderboard. It now ranks from the
  most-attended events.
- The KPI grid and the spotlight grid used container queries and viewport
  breakpoints respectively, so collapsing the sidebar reflowed them at different
  widths.
- Role badges in the users table hardcoded violet/blue/green hexes.

### Performance

- `chat_messages.parent_id` is a self-referencing foreign key and had no index,
  so deleting a chat group made Postgres scan the whole table once per cascaded
  message. At 500,000 rows that is roughly 2.5e10 comparisons and the delete
  never returns — three attempts to remove the load-test dataset from staging
  failed on this before the cause was found. The same path runs on event
  deletion and on account deletion.

## [0.5.2] - 2026-08-05

### Added

- Tooling to measure API performance against realistic data volume, and a
  recorded baseline. The previous benchmark only measured endpoints that reject
  the request, so it never exercised a single database query.

### Verified

- With 1000x the current data (10,000 accounts, 2,000 events, 500,000 chat
  messages) the real endpoints respond in 207-238ms, against a 200ms floor that
  is network round-trip. The heaviest one adds about 38ms of actual work. No
  slow queries, and no missing indexes.

## [0.5.1] - 2026-08-05

### Fixed

- The v0.5.0 deploy failed to build. An API-documentation package still required
  the previous major version of the validation library, so installing the two
  together was impossible. Upgraded it; nothing was ever served from the broken
  build, and both environments stayed up on the previous release throughout.
- Continuous integration now installs dependencies the same way the deploy does.
  It had been using a flag that ignores exactly this class of conflict, which is
  why it reported success while the deploy could not build.

## [0.5.0] - 2026-08-04

### Changed

- Upgraded the request-validation library to zod 4. Error responses are
  unchanged — the groundwork for this went in back in v0.2.0, so the endpoints
  themselves needed no edits.

## [0.4.0] - 2026-08-04

### Changed

- Upgraded the database layer to Prisma 7. Connection handling moved to the
  driver-adapter model the new version requires. No query behaviour changed —
  verified by running the integration suite against a copy of real data.

## [0.3.0] - 2026-08-04

### Security

- **No known vulnerabilities remain.** The last three needed this framework
  upgrade; the count is now zero, down from 47 at the start of the day.

### Changed

- Upgraded to Next.js 16. The dashboard now ships 11% less JavaScript
  (3754 KB → 3329 KB), so it loads faster.
- Linting moved to the standard ESLint command, since the framework removed its
  own wrapper. It now covers the whole project rather than part of it.

### Known

- The new linter surfaced 10 pre-existing warnings in dashboard components
  (state updates inside effects that cause extra renders). They do not affect
  correctness and are tracked for follow-up.

## [0.2.5] - 2026-08-04

### Added

- A smoke test that runs against a deployed environment and checks the things
  that actually break: the database is really reachable, bad input is rejected
  properly, the scheduled-jobs endpoint stays locked, the API spec is intact,
  and the realtime connection refuses a bad token. It exits with an error, so it
  can gate a release rather than just report.
- A performance baseline, so the framework upgrades coming next can be checked
  for slowdowns instead of assumed fine.

## [0.2.4] - 2026-08-04

### Fixed

- Push notification failures were discarded without a trace in four places. If
  push stopped working, nothing anywhere would have said so. Failures are now
  recorded; sending still never blocks the request that triggered it.

## [0.2.3] - 2026-08-04

### Fixed

- Errors thrown while the app's root layout renders were never reported. That is
  the case where someone sees a blank page, so it was the one failure we had no
  visibility into. They now report, and the page shows a reference code to quote
  when reporting the problem.

### Changed

- Builds are now warning-free. Cleared a deprecated Sentry option, moved browser
  error tracking to the filename the next major version of the framework
  requires (it silently stops working otherwise), and moved CI onto a supported
  Node version.

### Added

- A script to copy one database into another, used to give the staging
  environment realistic data so upgrades can be tested against something other
  than an empty schema.

## [0.2.2] - 2026-08-04

### Added

- Integration tests that run against a real database in CI. The existing test
  suite replaces the database with a stand-in, which means it cannot notice if a
  database library upgrade breaks every query — the tests stay green while the
  app stops working. These execute real queries, so that failure now shows up
  before release rather than after.

## [0.2.1] - 2026-08-04

### Changed

- Updated 34 dependencies to their latest compatible releases, mostly UI
  components and React. No package changed its major version, so behaviour is
  unchanged.

## [0.2.0] - 2026-08-04

### Security

- Known vulnerabilities went from **47 to 3** (was 6 critical, 21 high, 19
  moderate, 1 low). The three that remain all need a Next.js major upgrade and
  are being handled separately.
- Removed the Clerk authentication SDK. It was installed but never used — this
  app signs in with NextAuth — and it carried four of the advisories on its own.

### Changed

- Validation errors are read through the API that survives the next major
  version of the validation library. Behaviour is identical today; without it,
  that upgrade would have turned every rejected request across 26 endpoints into
  a server error instead of a validation message.

### Added

- Tests that pin the above, including one that fails if the old API comes back.

## [0.1.9] - 2026-08-04

### Removed

- `DIRECT_URL`. Prisma's `directUrl` exists for deployments where the app talks
  to a connection pooler and migrations have to bypass it. This one connects to
  Postgres directly, so it was a second copy of `DATABASE_URL` that had to be
  kept in sync — and forgetting it in CI is what kept every CI run red.

## [0.1.8] - 2026-08-04

### Fixed

- Startup reported "Error checking bucket" and treated object storage as
  unavailable when the bucket was actually fine. Applying the public-read policy
  is best-effort — Tigris does not implement S3 bucket policies — and no longer
  decides whether storage works.
- Restored the version headings for 0.1.2 through 0.1.6, which were lost while
  the entries were being written.

## [0.1.7] - 2026-08-04

### Changed

- List endpoints that previously fetched every matching row now return a bounded
  page. Fine at today's volumes, but the event list in particular grew with the
  whole table. Response shapes are unchanged.
- Page-size limits come from the shared configuration instead of being written
  into each route.

## [0.1.6] - 2026-08-04

### Fixed

- Switching filters quickly in the moderation queue could leave an older result
  on screen, showing a reviewer the wrong set of flagged messages. Requests are
  now cancelled when superseded.
- Copying generated credentials reported success even when the copy silently
  failed, which loses one-time credentials. Failures now say so and tell you to
  copy manually.

### Added

- Loading placeholders on the dashboard overview, events, chatrooms, organisers,
  and venue owners pages. They previously showed nothing at all while their data
  loaded.
- Accessible names on the remaining icon-only buttons, so screen readers
  announce them.
- The organiser and venue owner tables now distinguish "no results for your
  search" from "none created yet".

## [0.1.5] - 2026-08-04

### Fixed

- Setting up a new environment from the deployment docs silently disabled file
  uploads. The docs and the validation schema both named the storage variables
  `AWS_*`, but the code reads `TIGRIS_*`, so uploads returned 503 with nothing
  explaining why. All three now agree.

### Added

- `.env.example` documenting every variable the code reads, including the two
  that fail quietly: without `OPENAI_API_KEY` moderation drops to keyword
  matching, and without `TIGRIS_*` uploads are off.
- Error reports are scrubbed before leaving the server. Emails, tokens, upload
  signatures, cookies, and request bodies are removed, and the reporting user is
  reduced to an id. Expected errors — navigation aborts, offline requests,
  expired sessions — no longer report at all.
- A build-time warning when `SENTRY_AUTH_TOKEN` is missing in a production
  build, which otherwise succeeds and ships unreadable stack traces.
- A real README, replacing the create-next-app boilerplate.

## [0.1.4] - 2026-08-04

### Changed

- Server logs are now structured throughout. 112 raw `console` calls across 76
  files were routed through the existing logger, so production incidents can be
  correlated by user, event, and operation instead of scraped out of free text.

### Fixed

- Error handlers logged whole error objects, which for database failures can
  include the query text and its parameters. They now record the message only.
- Restarting the server left sponsored-message timers running, so shutdown
  waited for the forced-exit timeout instead of exiting cleanly.
- A leftover debug line printed the cover image URL on every event creation.

## [0.1.3] - 2026-08-04

### Fixed

- Editing a sponsored message with a malformed value returned a server error
  instead of a validation message. All organiser broadcast content is now
  validated and length-capped before it is saved.
- Message requests could be sent with an empty message body.
- Anyone with a dashboard login could request an upload URL, including attendee
  accounts that have no reason to upload. Now limited to admins, organisers, and
  venue owners.
- Message-request push notifications previewed the sender's text on the lock
  screen. They now say only who wants to connect; the message stays in the app.

### Added

- Rate limits on the endpoints that fan out to many people: announcements and
  sponsored messages (10/min per organiser) and direct messages (30/min per
  sender). These are keyed per account rather than per IP, so one account cannot
  spread its load across addresses.
- 23 tests covering the new validation and rate-limit behaviour.

## [0.1.2] - 2026-08-04

### Fixed

- Getting signed out on every device after a normal app interruption. If the app
  was backgrounded or killed while refreshing its login, the next launch looked
  like a stolen-token replay and logged you out everywhere. A replay within a
  minute of rotation is now treated as the retry it almost always is; a replay
  long after still revokes every session.
- Sign-in with Google or Apple wrote raw error objects and account details to the
  server log. Failures are now recorded through the structured logger without the
  payload.

### Changed

- CI now runs on the `dev`, `stage`, and `prod` branches. It previously listed
  `main`, which does not exist in this repository, so pushes to `stage` and
  `prod` ran no checks at all.

### Added

- Tests for refresh-token rotation, reuse handling, and storage — 7 new tests.

## [0.1.1] - 2026-08-04

### Fixed

- Real-time typing indicators and read receipts in direct messages could be
  forged. Any signed-in account that knew a conversation id could make it look
  like a stranger was typing in your DM, or mark your messages as read. Both now
  require you to actually be one of the two people in the conversation.
- Declining an invitation to a private event no longer leaves you with a live
  feed of who is attending it. Only a `going` or `maybe` RSVP grants access.
- Deleted events no longer expose their live check-in activity.
- Typing indicators now stop for members who have been muted or banned, instead
  of continuing until they close the app.
- Direct-message typing indicators showed the sender's email address instead of
  their name. They now show the profile name.
- A malformed room id sent over the socket connection could crash the server for
  everyone. Room joins now refuse the request instead of taking the process down.

### Changed

- Refused room joins return a uniform response, so the socket connection can no
  longer be used to probe which chats, conversations, and events exist.

### Added

- Test coverage for socket room authorization, role permissions, and mobile
  token handling — 33 new tests across 4 suites (68 → 101 total).

### Documentation

- `docs/SOCKET_EVENTS.md` now matches the server. It previously documented
  `chat:join`, `chat:message`, and `chat:typing` as client-to-server events;
  none of those exist. Added the room authorization rules and corrected the
  `event:checkin` and `chat:typing` payloads.
