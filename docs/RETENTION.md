# Retention after deletion (IT Rules 2021)

Blend'n is India-only, so account deletion follows the IT (Intermediary
Guidelines) Rules 2021, and the DPDP Act 2023 once they stop applying.

## r.3(1)(h): registration information, kept 180 days

`DELETE /api/mobile/account` anonymises the `User` row and scrubs the profile at
once. Before it does, in the same transaction, it copies what the person
registered with into `deleted_account_records`:

| Column | From |
|---|---|
| `user_id` | the anonymised `User` row's id |
| `name` | `profiles.name`, else `User.name` |
| `email`, `account_created_at` | `User.email`, `User.createdAt` |
| `phone`, `date_of_birth` | `profiles` |
| `sign_up_method` | `email` if a password was set; otherwise the first `google`/`apple` link in `user_oauth_accounts` (or NextAuth `Account`) |
| `deleted_at` | the same instant as `User.deletedAt` |
| `purge_after` | `deleted_at` + 180 days |

The copy is part of the deletion transaction. A failed deletion leaves no copy,
and a successful one always has one. Code: `lib/deleted-account-records.ts`.

**Purge.** The retention sweeper (`lib/notification-retention.ts`, every six
hours and at boot) hard-deletes rows whose `purge_after` has passed. It is
idempotent and logs only a count.

**Access.** No route, dashboard page or helper reads the table.
`__tests__/deleted-account-records-boundary.test.ts` fails the build if anything
under `app/`, `components/` or `lib/` names it, apart from its one writer.

## Answering a legal request

A request from a court or an authorised agency under the IT Act is answered by an
app admin with database access. Nothing else answers it. Log the lookup in
`audit_logs` inside the same transaction as the read, so the lookup and its
record stand or fall together:

```sql
BEGIN;
INSERT INTO audit_logs (id, user_id, action, resource, resource_id, details, created_at)
VALUES (gen_random_uuid(), '<admin User.id>', 'legal_request.lookup', 'deleted_account_records',
        '<user id or email searched>',
        '{"reference": "<order / notice number>", "authority": "<who asked>"}', now());
SELECT * FROM deleted_account_records WHERE email = '<email>' OR user_id = '<user id>';
COMMIT;
```

Connect with the Postgres service's `DATABASE_PUBLIC_URL`, not `railway run`.
Send the result over the channel the request came through. Never paste it into
Jira, Slack or a log.

## r.3(1)(g): removed content, kept 180 days

What moderation removes is soft-deleted and stays, including after its author
deletes their account:

- **Room messages:** `deleted_at` and `moderation_status = 'hidden'`. Records
  are in `moderation_flags`, `message_reports` and `audit_logs`.
- **DMs:** `moderation_status = 'hidden'`, with `message_reports`. Account
  deletion closes the conversation and keeps the messages.
- **Images in those messages:** account deletion erases the person's
  `chat/<id>/` objects, and the `chat/sealed/<uuid>` copies their own messages
  point at (a sealed copy's key names nobody since SCRUM-448, so the messages
  are how it is found: `eraseChatMedia`), except the images of their messages
  that are removed content (`retainedChatMediaKeys`, `lib/retained-media.ts`,
  SCRUM-428):
  - hidden or flagged;
  - deleted by someone other than the author;
  - carrying a flag nobody cleared;
  - reported by someone else, with the report not dismissed.

  If that set cannot be read, `chat/` is left alone rather than erased. The
  kept images go at 180 days, with the registration record: the retention
  sweep erases everything left under `chat/<id>/`, and every sealed copy the
  person's messages still point at, before it purges the record,
  and keeps a record whose images it could not erase for the next pass
  (SCRUM-429). At 180 days they go, with one exception (SCRUM-955, owner row A-24): an image whose
  report was filed before the deletion and is still pending waits on a pointer (`retained_report_media`: account id, object key,
  message id) until the report is decided, and for at most 15 days past the purge (`REPORT_HOLD_DAYS`, the grievance period of
  IT Rules 2021 r.3(2)(a)(i)); the sweep warns in the last 5. The record, profile media and photo checks go on schedule. A flag
  nobody cleared loses its image at 180 days. Nothing in the product records a legal hold. Images sent since SCRUM-427 are in the private bucket and served
  only through signed URLs. Known gaps: images from before SCRUM-427 that are
  kept stay in the public bucket until then. A report filed after the deletion
  finds the image already gone, and the reports screen says so with the date.
- **Profile photos** (SCRUM-479): a photo moderation pulls, and the blur of a
  pulled primary, are recorded `photo_checks.hidden` and moved from the public
  bucket to the private one under the same key, so the URL answers 404. Account
  deletion keeps those objects and their `photo_checks` rows
  (`retainedProfilePhotoKeys`) and erases the rest of `profile/<id>/`. The
  180-day purge erases what is left under `profile/<id>/` in both buckets, and
  the rows with it. Photos pulled before SCRUM-479 recorded no verdict and are
  not kept.
- **Lobby posts:** `moderation_status = 'hidden'` or `'removed'`, and posts whose
  photo moderation rejected (`photo_status = 'rejected'`, `photo_checked_at` the
  removal). Account deletion deletes the author's other posts, and their photos
  from storage, but keeps these.
- **Events:** soft-deleted or delisted, with `event_reports` and `audit_logs`.

The `User` row is never deleted, and neither are events or event rooms.

## Event content: the Lobby, the room and the posts' rooms (SCRUM-1026)

Owner decision 6 (2026-11-05; the DPDP and IT Rules points to be confirmed by
the lawyer). The Lobby, an event's room and its posts' rooms close for users at
the same moment, a day after the event ends (a venue day's at its reset), and no
app read returns them afterwards. They are kept server-side only, for safety,
reports and legal requests, and 180 days after the close the chat sweeper
(`lib/lobby-retention.ts`, every 15 minutes) hard-deletes:

- the room's messages and each post's room's messages (their reactions, flags
  and polls cascade; a reply's parent is set null), and any image they carry;
- Lobby posts, with their asks (`board_requests` cascades) and their photo in
  storage, and each post's room once it is empty;
- the host's pinned post.

Alert switches (`board_alert_preferences`) go at the close.

**What the room felt is kept, anonymously** (owner, 2026-11-06). The purge does
not delete `event_feedback`: before it takes an event's first message it freezes
the event's figures in `event_feedback_tallies` (distinct people per category,
counted as the digest counts them, and the room's member count), then detaches
each feedback row from its message (`message_id` null) and from the staff member
who corrected it (`corrected_by` null). What stays is mood, category,
confidence, source and times: no user id, no words, no pseudonym. The Feedback
tab (`buildFeedbackDigest`) reads the frozen figures once they exist, so every
count, category and suppression reads the same after the purge as before; only
the quotes go, because they are the words. Account deletion still takes a
person's feedback rows with their messages (ON DELETE CASCADE), as before.

**Who was in the room is kept; what they were called is not** (owner,
2026-11-06). The purge keeps every `chat_group_members` row (the room's size,
and which rooms a person was in, are read elsewhere), but in the same pass that
takes the room's messages it sets each row's `anonymous_name` to NULL, so
nothing links a person to the name the room knew them by. A row is blanked once
none of that person's messages is left in the room: a member whose message is
held (below) keeps the name it was written under until the message goes. Event
rooms and a post's room alike; a post's room that empties is deleted with its
members, as before. Every reader of the column already falls back to
"Attendee" (or "Someone") for NULL, and a closed room is unreachable from the
app. "Came back" (`lib/loop-closure.ts`) counts check-ins, not member rows, so
it reads the same.

**A dismissed report's words** (status `reviewed`): the `excerpt` it quoted and
the reporter's own `description` both go 180 days after the dismissal, for every
kind of report. The report itself stays (who, what, reason, status, dates). An
upheld or a pending report keeps both.

**Held from removal, not from the close:** a message removed by anyone but its
author (a host, a moderator, the pipeline) or carrying a moderation flag nobody
cleared; a post moderation took down or whose photo it rejected; anything with a
report upheld (`resolved`) within 180 days. Anything with a report still
`pending` is held until it is decided. A held message keeps its post and its
room. A storage delete that fails keeps its row for the next pass.

**Not yet:** the purge is a dry run that logs counts until `LOBBY_PURGE=delete`
is set on the service. Turn it on once the privacy policy says these windows
(draft: `.context/plans/privacy-retention-draft.md`).

**Tonight's question answers go at 30 days** (owner, 2026-11-10):
`event_match_preferences.tonight_answer`, and `work_intent` beside it (why they
were there, read by the same people), are set NULL 30 days after the event's
last night ends (`purgeTonightAnswers`, same sweeper). The row and the person's
other preferences stay. It is not behind `LOBBY_PURGE`: an answer is not held
content. One refused by moderation is never stored, and no report copies an
answer (a person report keeps only the reporter's reason and description), so
an open report holds nothing here.

**Stored media is `no-cache`.** Every profile photo and chat image is the
server's sealed copy (`sealUpload`), stored with `Cache-Control: no-cache`, so
deleting it (account deletion, a removed photo, a moderation takedown) stops it
being served at once. Objects sealed before SCRUM-445 keep the storage default
and stay fetchable at the edge for up to an hour after a delete.

**Known gaps, not yet fixed:**

- **User file deletes.** `DELETE /api/mobile/uploads/delete` lets a user delete
  their own files in `profile/`, `chat/` and `events/` whatever their moderation
  state. That includes images in hidden or reported messages.
- **Delisted events.** After an admin delists an event, the organizer can still
  edit its title and description, and its `visibility` too
  (`PUT /api/events/[id]`). The delisting's audit entry keeps only the subject
  id, so nothing keeps the original text.
