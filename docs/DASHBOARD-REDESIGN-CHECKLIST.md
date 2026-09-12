# Dashboard redesign checklist

One row per screen. **Chain** means the gated chain in `TESTING-PLAYBOOK.md` §1
was run for the screen — operator questions and cuts, a direction with a
memorable detail, a mockup on disk, then built and driven with the row read
back. **Driven** means the screen was exercised end to end on the running app
(browse / Chrome DevTools, later Playwright) with its writes read back from
Postgres. Both columns cite the commit or PR that did it, so a tick can be
checked rather than trusted.

`E17` (SCRUM-42, 2026-08-27) was a density and responsive pass over thirteen
pages — prose cut, zero overflow at 375/768/1280 — and is **not** a redesign;
it appears here only as a note.

Order of work: the product owner's call on 2026-09-11 — the organiser's
authoring screens first, then the rest of the organiser surface, then venue
owner, then the admin remainder. Each screen goes through the chain, the six
gates, the specialists, and a drive, before the next one starts.

## Legend

- ✅ done, with the commit / PR
- ◐ partial — part of the screen went through the chain, the rest did not
- — not done

## Shared

| Screen | Chain | Driven | Notes |
|---|---|---|---|
| Nav, tokens, sidebar groups | ✅ 1482a7a, 7b512ac | ✅ every drive since | `lib/dashboard-nav.ts` groups; colours back on tokens |
| Site header (one `h1`) | ✅ f8a0ded, E17 | ✅ | `KNOWN_DOUBLE_H1` is empty |
| DataTable primitive | ◐ c1ff7fb (server search), 26fe6a4 | ✅ venues | not itself a screen |

## app_admin

| Route | Chain | Driven | Notes |
|---|---|---|---|
| `/dashboard` (admin overview) | ✅ 5c3e7f9 | ✅ Chrome DevTools 2026-09-10 | five panels, attention strip |
| `/dashboard/moderation` | ✅ 2026-09-11 (chips → words; mockup skipped — DataTable pattern) | ✅ E10; 2026-09-11 with two seeded flags | erased author reads "Deleted account" |
| `/dashboard/moderation/reports` | ✅ 2026-09-11 (same) | ✅ E10 | |
| `/dashboard/events` (list) | ✅ 46d00fb, 380ba27 | ✅ 2026-09-10 | server-fetched, zero column fixed |
| `/dashboard/events/curate` | ✅ #276-era W5 + design review 2026-08-24 (6→9/10) | ✅ browser, 2026-08-24 | form → `components/ui/form`, timezone bug |
| `/dashboard/events/new` | ✅ 081bd48 (mockup `event-authoring-20260911`) | ✅ 2026-09-11, published + edited + cancelled, rows read back | four sections + sticky publish rail; Status select, required long description, category wall, organiser-settable Featured all cut |
| `/dashboard/events/[id]/edit` | ✅ 081bd48 | ✅ 2026-09-11 | same form; rail says Published, Save changes, Cancel event… |
| `/dashboard/events/[id]` (overview, live, attendees tabs) | ✅ 8d6f547 (mockup `event-page-20260911`) | ✅ E8/E9; 2026-09-11 draft/upcoming/over looked at as organiser | lifecycle strip replaces the status badge; hero is Going (maybe · saved), Came when nobody RSVP'd; sections with rules, not cards |
| `/dashboard/events/[id]/messaging` | ✅ d1096f7 (mockup `event-messaging-20260911`) | ✅ E10; 2026-09-11 as organiser + venue owner | the room's pulse line; composer sticky; templates as chips; header retitled "Room" |
| `/dashboard/events/[id]/feedback` | ✅ d1096f7 (mockup `event-feedback-20260911`) | ✅ E12; 2026-09-11 | sentiment bar is the hero; sections with rules; stars only when rated |
| `/dashboard/chatrooms` | ✅ (see organizer) | ✅ E10 | E17 fixed the 403-as-empty state |
| `/dashboard/users` | ✅ 380ba27, 99bf013, f2aa14e | ✅ 2026-09-11 local + read back | deleted-account state, status Select |
| `/dashboard/organisers`, `/organisers/[id]` | ✅ 503dead (index) / ✅ a638b48 (detail, `RoleUserDetail`) | ✅ index; detail 2026-09-11 | |
| `/dashboard/venues` (admin index), `/venues/[id]`, `/venues/new`, `/venues/[id]/claim` | ✅ c1ff7fb, 634bfae (index) / ✅ 2026-09-11 (detail, new, claim — shared with venue owner) | ✅ index 2026-09-10 | |
| `/dashboard/venue-owners`, `/venue-owners/[id]` | ✅ 503dead (index) / ✅ a638b48 (detail) | ✅ index | shares `RoleUserDetail` |
| `/dashboard/leads` | ✅ a638b48 | ✅ E3 | status as a word; duplicate h2 cut |
| `/dashboard/claims`, `/claims/venues`, `/claims/brands` | ✅ W5 + design review 2026-08-24 (events) / ◐ (venues, brands share the queue) | ✅ E7 | one queue, three kinds |
| `/dashboard/onboarding` (applications) | ✅ ac0962f, ce62887, 2fd92dd | ✅ 2026-09-11 | credential panel, evidence order |
| `/dashboard/sponsors` (brands) | ✅ a638b48 | ✅ E6 | duplicates section only when there are any |
| `/dashboard/creative-review` | ✅ a638b48 | ✅ E6 | rule beside the buttons |
| `/dashboard/charges` | ✅ a638b48 | ✅ E6 | MetricTiles + divided ledger |
| `/dashboard/organisations` | ✅ a638b48 | ✅ E7 | divided list, controls to the right |
| `/dashboard/categories` | ✅ a638b48 | ✅ E3 | merge keeps interests (W14); counts as text |
| `/dashboard/amenities` | ✅ a638b48 | ✅ #298 | list first, add form last |
| `/dashboard/reports` | ✅ a638b48 | ✅ E12 (exports) | radio list, one orange button |
| `/dashboard/audit` | ✅ a638b48 | ✅ E3 | mono words; en-GB pinned (hydration) |
| `/dashboard/settings` | ✅ a638b48 | ✅ E3 | one primary |

## organizer

| Route | Chain | Driven | Notes |
|---|---|---|---|
| `/dashboard` (organiser overview) | ✅ ea82077 (mockup `overview-organizer-20260911`) | ✅ 2026-09-11 as Arjun Rao | pacing vs last event, days-to-go, ratings only when rated |
| `/dashboard/events` | ✅ shared with admin | ✅ | organiser scope = org membership |
| `/dashboard/events/new` | ✅ 081bd48 | ✅ 2026-09-11 | shared with admin |
| `/dashboard/events/[id]/edit` | ✅ 081bd48 | ✅ 2026-09-11 | |
| `/dashboard/events/[id]` + tabs | ✅ 8d6f547 | ✅ 2026-09-11 | shared with admin |
| `/dashboard/events/[id]/messaging` | ✅ d1096f7 | ✅ 2026-09-11 | shared with admin |
| `/dashboard/events/[id]/feedback` | ✅ d1096f7 | ✅ 2026-09-11 | shared with admin |
| `/dashboard/attendees` | ✅ 2026-09-11 (repeat chip cut; mockup skipped — one column) | ✅ E4; 2026-09-11 | pseudonymous roster |
| `/dashboard/chatrooms` | ✅ 2026-09-11 (mockup `chatrooms-20260911`) | ✅ 2026-09-11 | a list with state + when it changes; scope via visibleEventsWhere |
| `/dashboard/organisation` (my organisation) | ✅ 2026-09-11 (chrome cut; mockup skipped) | ✅ E4, #322 domain verification | title line, divided lists |
| `/dashboard/reports`, `/dashboard/audit`, `/dashboard/settings` | — | ✅ | shared |

## venue_owner

| Route | Chain | Driven | Notes |
|---|---|---|---|
| `/dashboard` (venue-owner overview) | ✅ ea82077 (mockup `overview-venue-20260911`) | ✅ 2026-09-11 as Fatima Sheikh | `visibleEventsWhere` scope (H2 fixed here); peak cell outlined; notes as text |
| `/dashboard/venues` (my venues), `/venues/[id]` | ✅ 6e47108 (my venues, mockup skipped — the row pattern) / ✅ 3233c27 (mockup `venue-detail-20260911`) | ✅ E5, #319 lifecycle; 2026-09-11 as Fatima | rows with rules; numbers first, record last; no chips |
| `/dashboard/venues/new`, `/venues/[id]/claim` | ✅ 2026-09-11 (chrome cut; mockups skipped) | ✅ E7; 2026-09-11 | header titles for both routes |
| `/dashboard/events`, `/events/[id]` | shared | ✅ | canOperate tabs |
| `/dashboard/chatrooms`, `/organisation` | ✅ shared | ✅ | |
| `/reports`, `/audit`, `/settings` | — | ✅ | shared |

## sponsor

| Route | Chain | Driven | Notes |
|---|---|---|---|
| `/dashboard` (sponsor overview) | ✅ #299 + sponsor-surfaces mockup 2026-08-16 | ✅ E6 | |
| `/dashboard/brand` | ✅ same | ✅ E6 | |
| `/dashboard/placements` | ✅ same | ✅ E6 | reach suppressed |
| `/dashboard/organisation`, `/settings` | — | ✅ | shared |

## The queue, in order

1. ~~`/dashboard/events/new` and `/events/[id]/edit`~~ — done 2026-09-11 (081bd48)
2. ~~`/dashboard` for organiser and venue owner~~ — done 2026-09-11 (ea82077)
3. ~~`/dashboard/events/[id]` — overview, live, attendees, messaging, feedback~~ — done 2026-09-11 (8d6f547, d1096f7)
4. ~~`/dashboard/attendees`, `/dashboard/chatrooms`, `/dashboard/organisation`~~ — done 2026-09-11
5. ~~`/dashboard/venues/[id]`, `/venues/new`, `/venues/[id]/claim` (venue owner)~~ — done 2026-09-11
6. ~~Admin remainder: moderation (+reports), sponsors / creative-review / charges, organisations, organisers/[id], venue-owners/[id], leads, categories, amenities, reports, audit, settings~~ — done 2026-09-11 (a638b48 + moderation follow-up)

**The queue is empty.** Every dashboard route except `/login` has been through the chain.

`/design-review` ran 2026-09-11 over the result (report: `~/.gstack/projects/Matryx-Social-Labs-Blendn-Admin/designs/design-audit-20260911/`): 15 findings, 9 fixed in nine `style(design): FINDING-NNN` commits (10e5c64 … 5530cc7), design score B+ → A. Deferred, for the testing phase: the audit log groups days by browser timezone (`toDateString()` in a client component — will hydrate differently on Railway), the hand-typed type scale (209× `text-[0.8125rem]` while `--text-small` is unused — a codemod, its own PR), the map placeholder hex and primitive shadows. The venue owner's `/dashboard/venues` was mis-ticked above as shared with the admin index; it went through the chain in 6e47108.

## Driven 2026-09-12 — the journeys, both surfaces, rows read back

The testing routine ran over the finished redesign. Dashboard journeys driven
through `browse` against the seed on :3100, the phone half on the iOS
simulator against the same server (Android: not driven — the emulator fell
to 1.5 fps and `adb` stopped answering; recorded in the playbook). Every row
below was read back with `psql`.

| Journey | Surfaces | Read back |
|---|---|---|
| Announcement → room | dashboard → iOS | `chat_messages type=announcement`; rendered as ANNOUNCEMENT on the phone |
| Attendee sends a message | iOS → dashboard | 500 on first try (**SCRUM-83**, fixed); then the row, and Cosmic Panda on the organiser's feed |
| Organiser moderation: Keep one, Remove one | dashboard → iOS | `moderation_flags` approved/rejected, message `hidden`, two `audit_logs` rows; the removed message gone from the phone (**SCRUM-85**) |
| Admin moderation: Remove | iOS → dashboard → iOS | `hidden`, `moderation.message_removed`; the phone dropped it **live** once the emit reached a socket (**SCRUM-82**) |
| Check out, check back in | iOS → dashboard | `event_check_ins checked_in`, `presence_sessions` open; Rooms page "1 person inside"; Banter "Live now" only after the `check_out_time` fix |
| Venue owner edits capacity | dashboard | `venues.capacity` 300→320→300, `venue.updated` |
| Organisation invite | dashboard | `organisation_invites` staff, expires +7d, `org.invite` |
| Feedback label correction | dashboard | `event_feedback sentiment=neutral source=human corrected_at`, `feedback.label_corrected` |
| Category rename, amenity add | dashboard | `categories.name`, `category.renamed`; duplicate amenity refused (**SCRUM-85**) |
| Users: deleted filter | dashboard | 46 accounts / 1 deleted; row has no menu, no chips |
| Reports export | dashboard | 200, 2 rows, `report.exported` with the window |
| Settings name save | dashboard | `User.name` round trip |
| Claims: decline, approve application, hand over | dashboard → mobile API | dead-ended on the first try (**SCRUM-84**, fixed); then `event_claims approved`, `events.organizer_org_id`, `claimed_at`, siblings superseded; new organiser signed in and opened the event |
| Organiser creates and publishes | dashboard → mobile API | `events published`, org set, venue linked, fence; mobile detail names the org, not the creator (**SCRUM-84**) |

**Android, second attempt (later on 2026-09-12, iOS simulator shut first):**
the emulator held for ~25 minutes. Driven with the Maestro CLI (the MCP's
driver kept a dead connection to the earlier boot) and `adb shell input
text` for anything longer than a word: room + announcement ✅, send a
message ✅ (row read back, flagged), admin Remove reaching the emulator
**live** ✅ (`android-after-remove`), check-out ✅ (`checked_out`,
`departed_source=user`). Check-in: not driven — the emulator console
accepted `geo fix` but the framework's GPS provider kept the Mountain View
default, so the app sat waiting on a position. Two Android-only client
notes: the room's chat presents *over* the Grid there (SCRUM-86 is iOS
only), and the event detail logs "Encountered two children with the same
key" on Android.

**After the drive, decided and shipped:** contact details are removed on
write in a room (server `6a76f43`, iOS-verified), and a removed message is
a dashed "This message was removed by moderation." placeholder on the
client (`f982a76`, iOS-verified). The event room's own send route
(`POST /events/:id/chat`) was also returning 500 on every plain message —
two more explicit-undefined shapes — and now has an integration suite that
posts through both routes against real Postgres.

Fixed on this branch: SCRUM-82 (P0 socket instance), SCRUM-83 (P0 chat send),
SCRUM-84 (P1 claim funnel + host leak), SCRUM-85 (P2 ×7). Recorded, not
fixed: SCRUM-86 (client: Join Chat opens behind the Grid modal), SCRUM-87
(client: empty bubbles for removed messages; a timeout rendered as "not open
yet"), SCRUM-88 (decision: admin queue shows real names by default).
