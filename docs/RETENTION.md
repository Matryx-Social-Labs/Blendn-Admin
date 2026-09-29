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
  `chat/<id>/` objects except the images of their messages that are removed
  content (`retainedChatMediaKeys`, `lib/retained-media.ts`, SCRUM-428):
  - hidden or flagged;
  - deleted by someone other than the author;
  - carrying a flag nobody cleared;
  - reported by someone else, with the report not dismissed.

  If that set cannot be read, `chat/` is left alone rather than erased. The
  kept images go at 180 days, with the registration record: the retention
  sweep erases everything left under `chat/<id>/` before it purges the record,
  and keeps a record whose images it could not erase for the next pass
  (SCRUM-429). At 180 days they go whatever is still open on them: a report
  nobody has reviewed, or a flag nobody cleared, loses its image then. Nothing
  in the product records a legal hold that would stop it. Images sent since SCRUM-427 are in the private bucket and served
  only through signed URLs. Known gaps: images from before SCRUM-427 that are
  kept stay in the public bucket until then, and a report filed after the
  deletion finds the image already gone.
- **Board posts:** `moderation_status = 'hidden'`. Account deletion deletes the
  author's other posts but keeps these.
- **Events:** soft-deleted or delisted, with `event_reports` and `audit_logs`.

No sweeper or cascade removes any of these. The `User` row is never deleted,
and neither are events or rooms.

**Known gaps, not yet fixed:**

- **Profile photos.** A photo that moderation rejects is unlinked from the
  profile, but the file stays in storage. Its `photo_checks` row looks the same
  as a pass. Account deletion then deletes both (`deletePrefix('profile/<id>/')`
  and `photo_checks.deleteMany`). Keeping them needs a verdict on `photo_checks`.
- **User file deletes.** `DELETE /api/mobile/uploads/delete` lets a user delete
  their own files in `profile/`, `chat/` and `events/` whatever their moderation
  state. That includes images in hidden or reported messages.
- **Delisted events.** After an admin delists an event, the organiser can still
  edit its title and description, and its `visibility` too
  (`PUT /api/events/[id]`). The delisting's audit entry keeps only the subject
  id, so nothing keeps the original text.
