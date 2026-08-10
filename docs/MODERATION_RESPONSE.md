# Moderation: the human half

The pipeline works. `lib/moderation/` runs keyword matching, spam detection and
the OpenAI moderation API before a message is broadcast, and writes to
`moderation_flags`. `__tests__/` covers it.

None of that answers the question this document exists for: **it is 11pm on a
Saturday, a woman at an event has just been threatened in the chatroom, and she
has pressed report. What happens next?**

Today the honest answer is "the flag sits in a queue until someone opens the
dashboard on Monday". That is the gap.

An engineering review initially recorded "moderation is core product" as having
no deliverable, on the grounds that the classifier already exists. That was
wrong, and the correction is the reason this file exists: a moderation pipeline
with no human attached to it is a filing cabinet.

---

## What Yik Yak actually teaches

Worth being precise, because the wrong lesson is easy to draw.

Yik Yak did **not** die from lack of engagement or lack of context. Context was
why it worked -- hyperlocal, campus-bounded, extremely sticky. It died in April
2017 from **harassment**: racist threats, bomb and shooting threats that
triggered campus evacuations, two students arrested for death threats, and a
federal complaint against the University of Mary Washington for failing to
protect students from threats of sexual violence. Campuses banned it. It
relaunched in 2021 with "community guardrails" and students immediately reported
the same abuse.

So the risk here is not that nobody uses the room. It is that **the room turns
ugly once, publicly, and that ends the product** -- particularly in India,
particularly with women in it.

Our structural difference from Yik Yak is not context. It is **accountability**:
there is a GPS-verified real human behind every pseudonym, pseudonyms are stable
within an event, and peer ratings route to moderation rather than being
displayed. None of that helps if nobody is looking.

---

## The escalation path

### Severity, and what each one means

| | What it is | Response time | Who |
|---|---|---|---|
| **S1** | Credible threat of violence, sexual threat, anything involving a minor, or a coordinated pile-on in progress | **Now.** Minutes, at the event | On-call |
| **S2** | Harassment, unwanted sexual content, targeted abuse of one person | Same night, before the room closes | On-call |
| **S3** | Slurs, spam, general unpleasantness the classifier caught | Next business day | Whoever is on the queue |

The distinction that matters operationally: **S1 and S2 are live-event
problems.** The room closes 24 hours after the event ends and the people
involved are physically in the same building right now. A response on Monday is
not a slow response, it is no response.

### What "on-call" means while the team is small

Be honest that this is one or two people, not a rota:

1. **Alerting.** Any `moderation_flags` row at S1 or S2 pages the on-call
   person. Today nothing does this -- flags land in the table and wait. This is
   the single highest-value piece of unbuilt moderation work.
2. **Acknowledge within the response time above.** Even if the action is "read
   it, judged it S3", the clock stops on acknowledgement.
3. **Act.** The dashboard already supports hiding a message, and
   `checkAndAutoMute` exists. Banning from an event chat exists
   (`chat_group_members.status`).
4. **Record.** Every S1 and S2 gets a line in the incident log below, whatever
   the outcome.

### What the on-call person can actually do today

| Action | Where | Exists? |
|---|---|---|
| Hide a message | Dashboard moderation queue | Yes |
| Auto-mute a repeat offender | `lib/moderation/actions.ts` `checkAndAutoMute` | Yes, automatic |
| Ban from an event chat | `chat_group_members.status` | Yes |
| **See a user report at all** | `/dashboard/moderation/reports` | **Yes, since 0.61.0** |
| Suspend an account platform-wide | Reports queue, or `users` | Yes, and it now **works on the phone** |
| Reinstate a suspended account | Reports queue | Yes |
| **Contact the reporter** | -- | **No** |
| **Tell the organiser someone at their event is in trouble** | -- | **No** |
| **Get paged when a flag lands** | -- | **No** |

The three gaps at the bottom are the work. The last one is the most urgent,
because without it the response time above is aspirational.

---

## Reports: the queue, and what a decision means

Two mobile routes write reports — `POST /users/:userId/report` and
`POST /messages/:messageId/report` — and until 0.61.0 **nothing anywhere read
either table**. A harassment report produced a row no human was ever going to
see. Everything above about response times was, for reports specifically,
describing a queue that did not exist.

They live at `/dashboard/moderation/reports`, beside the flag queue rather than
inside it. `moderation_flags.message_id` is NOT NULL with a foreign key to
`chat_messages`, so it can hold neither a report about a *person* (no message)
nor one about a private message (wrong table) — and a flag is the pipeline's
opinion, while a report is a person asking for help. Same screen, one click
apart; the sidebar badge counts both.

**Three decisions, and they mean different things.**

| Decision | Status written | What it does |
|---|---|---|
| **Dismiss** | `reviewed` | A human looked and took no action |
| **Remove message** | `resolved` | Soft-deletes the message. **Group rooms only** |
| **Suspend** | `resolved` | Blocks the account everywhere and signs it out |

`reviewed` versus `resolved` is the difference between "we found nothing" and
"we acted", which is the question that gets asked about a report six weeks
later. Every decision writes `audit_logs`, and `reviewed_by`/`reviewed_at` on
the report itself.

**Remove is group-only.** `private_messages` has no `deleted_at` column, so
there is nothing to soft-delete in a DM — and adding one means filtering it in
the socket handlers and every DM query, to remove evidence from a conversation
only two people can see. The lever against a DM is the person, not the message.

**Suspension now reaches the app.** `users.suspended_at` had been read in
exactly one place, `socket-ops-auth.ts`, which guards the *organiser* ops
socket. Suspending an attendee stopped them opening a dashboard they never had
and changed nothing about the app they were in. It is now checked wherever a
mobile token is issued — sign-in, Google, Apple, refresh, session — and
suspending revokes the account's refresh tokens, so a live session dies within
one 15-minute access token. The person is told they are suspended and given an
address to appeal to; a silent failure to sign in is indistinguishable from a
bug and produces a support thread instead of an appeal.

**Reinstate is on the same row**, including after the fact. A suspension only an
engineer with database access can reverse is not reversible in any sense the
product can rely on.

---

## The reporting path has a hole in it right now

**A user cannot report a message in group chat.** `app/chat/[id].tsx:655` in the
Expo app shows a confirmation tray, fires a haptic, and calls nothing. The DM
path reports properly; the group path is a stub.

So the room where abuse is most likely has a report button that does nothing,
and the person who pressed it believes they have reported and concludes we
ignored them. That is worse than having no button.

`POST /api/mobile/messages/:messageId/report` exists and works, and now lands in
a queue somebody reads. Wiring the tray to it is the fix, and it is tracked as
T5 in the eng review.

---

## Group chats will make this harder

When group-to-group matching ships, the shapes change:

- **Pile-ons.** Four people against one is a different thing from one-to-one
  abuse, and per-message classification does not see it. Needs a rate/ratio
  signal, not a content signal.
- **Coordinated harassment.** A group can form specifically to target someone.
  The group is durable, so they can do it repeatedly across events.
- **Pressure to reveal.** The per-pair mutual reveal was designed so nobody can
  be pressured into unmasking, but social pressure in the chat itself ("why
  won't you show your face") is a content problem the classifier will not catch.
- **Post-event persistence.** A group conversation outliving the event means
  someone can be pursued after leaving the venue, which is precisely the
  situation the co-presence rule was meant to prevent.

None of these are solved. They are the design work in T7 and they should be
designed before group chat ships, not after the first incident.

---

## Incident log

Every S1 and S2, whatever the outcome. Blameless: the point is patterns, not
fault.

| Date | Severity | Event | What happened | Action | Time to ack |
|---|---|---|---|---|---|
| _(none yet -- pre-launch)_ | | | | | |

---

## What to build, in order

1. **Paging on S1/S2 flags.** Without it every response time here is fiction.
2. **Wire the group-chat report button** (T5, app-side).
3. **A way to reply to a reporter.** Silence after a report reads as dismissal.
   The queue now shows the reporter's name; it still cannot say anything back.
4. **A way to tell an organiser** that something is happening at their event,
   without disclosing who reported it.
5. **Group-chat abuse controls** (T7), before group chat ships.

## Reference

- `lib/moderation/` -- the pipeline
- `docs/chat-moderation.md` -- how it works
- `docs/client-chat-moderation-guide.md` -- what the app must render
- `docs/SECURITY_BACKLOG.md` -- the security ledger
