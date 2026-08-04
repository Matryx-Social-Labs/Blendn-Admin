# Changelog

All notable changes to Blendn Admin are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
