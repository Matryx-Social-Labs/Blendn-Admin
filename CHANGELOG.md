# Changelog

All notable changes to Blendn Admin are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
