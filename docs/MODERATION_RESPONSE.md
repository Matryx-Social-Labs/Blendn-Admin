# Moderation on call: reports, grievances, takedowns, child safety

One page for the person on call: what to do, and where in the dashboard. Every
path, button and action below was checked against `dev` on 2026-11-26. Who is
on call, response targets and anything private are in the on-call sheet
(SCRUM-1407). Legal questions go to the lawyer under Jira Epic SCRUM-1122.

Someone in danger now: emergency services first (112 in India, 911 in Canada).

## Who

| Role | Who |
|---|---|
| On call, who covers, the engineer on call, where alerts land | The on-call sheet (SCRUM-1407) |
| Grievance officer, `grievance@blendn.app` | Likhith Gowda, Chief Operating Officer (`lib/company.ts:19`; Matrix Social Labs, legally Matryx Social Labs Private Limited) |
| Decides what is reported to the authorities | `OWNER: name`, on the lawyer's answer (SCRUM-1398) |

## What arrives

Staff alerts go to `STAFF_ALERT_SLACK_WEBHOOK_URL` and/or `STAFF_ALERT_EMAIL`.
Open the queues on the schedule in the on-call sheet as well.

| Message | Do |
|---|---|
| `2 new reports, 1 severe flag; oldest pending 14 min.` and a dashboard link | Work the queues (**Act**) |
| `3 hidden lines the model could not judge.` (at most every 15 minutes) | Open the queue and read those lines; check `OPENAI_API_KEY` on the service and the provider's status |
| `Moderation degraded: …` | Check `OPENAI_API_KEY` on the service and the provider's status, or tell the engineer on call |
| `Sexual image pulled (profile). A person must check it for a minor or a non-consensual image. key profile/… user …` | Go to **Suspected image** below. The pull is listed at `/dashboard/audit?action=moderation.sexual_image_hold`, not in the queues |
| Mail to `grievance@blendn.app` | **Grievances and orders** below |

## Severity and clocks

**S1:** threat of violence, sexual threat, anything involving a minor, an
intimate image shared without consent, a court or government order. **S2:**
harassment, unwanted sexual content, targeted abuse of one person. **S3:**
slurs, spam, general unpleasantness. Targets per level: the on-call sheet.

Clocks per IT Rules as amended Feb 2026, lawyer to confirm:

| Acknowledge a grievance | Resolve a grievance | Grievance about unlawful content | Intimate or morphed image without consent | Court order or government notice |
|---|---|---|---|---|
| 24 h | 7 days | 36 h | 2 h | 3 h |

## Act

Sign in as `app_admin`. Both queues show the oldest first; the age turns red at
24 h. Switch with **Flags · N** and **Reports · N**. Every action writes `audit_logs`;
read them at `/dashboard/audit`.

| To | Where | Press | Audit action |
|---|---|---|---|
| Find a person named in a grievance | `/dashboard/users` | Search by name or email | none |
| Hide a flagged room message | `/dashboard/moderation`, Pending | **Remove** (or **Keep** to clear it). To suspend the author, see the no-report row below | `moderation.message_removed` / `moderation.flag_approved` |
| Hide a reported room message | `/dashboard/moderation/reports`, the card | **Remove message** (rooms only; for a DM, act on the person) | `report.remove_message` |
| Take down a reported Lobby post and its photo | the report card | **Remove post** | `report.remove_message` |
| Close a report with no action | the report card | **Dismiss** (the reporter hears nothing; acting on a report, such as **Suspend**, sends them a push) | `report.dismiss` |
| Suspend a person | the report card | **Suspend**: signs them out, blocks sign-in, stops notifications, bans them from every room | `report.suspend` |
| Suspend a person nobody reported | Signed in as the staff attendee account (where it lives: the on-call sheet), report their user id: `POST /api/mobile/users/<id>/report`, reason `staff: <why>`. Then **Suspend** on the new card; that account gets the "We acted on your report" push. Or ask the engineer on call. Never set `suspended_at` by hand: it skips the sign-out and the room bans | `report.suspend` |
| Reinstate | `/dashboard/moderation/reports`, **Resolved** (or **Reviewed**) tab, the card | **Reinstate**. Their rooms stay banned; they sign in again | `report.reinstate` |
| Let a reinstated person back into a room | `/dashboard/chatrooms`, **Open room** (a message report's card also links its event), then **Members**, **Banned** | **Unban**. The list shows room names; if more than one is banned, ask the engineer on call which is theirs. Otherwise they re-enter by checking in again | `chat.member_unban` |
| Remove a profile photo | Ask the engineer on call to pull it with `pullPhoto` (`lib/photos.ts`); suspend too if it warrants it | none |

## Suspected image (a sexual image that may show a minor)

Never assume an image was machine-screened. Treat every reported or paged image
as unreviewed. Until the lawyer answers SCRUM-1398:

1. Do not delete it, download it or forward it. Share the key and user id with nobody but the grievance officer. **Remove message** and **Remove post** take content down and keep it: use them.
2. Whether staff may open it to check waits on the lawyer. Until then `OWNER: name` decides: ask before you open it.
3. Suspend the account (**Act**; if nobody reported them, "Suspend a person nobody reported").
4. Open the incident ticket (below) with the time of the `moderation.sexual_image_hold` row and what you did. No key, no user id, no description of the image: the audit row holds the key.
5. Tell `OWNER: name` (the decider) now.

What is kept: a pulled profile or blur photo moves to the private bucket under
the same key, stays while the account lives, and is kept 180 days after the
account is deleted. A rejected Lobby photo stays private (`chat/sealed/…`) and
is kept 180 days after the verdict. Removed or reported room and DM images,
removed content and report rows are kept 180 days after the author deletes the account
(IT Rules r.3(1)(g); `lib/retained-media.ts:8-13`, `docs/RETENTION.md`). Whether
to keep anything longer: lawyer to confirm.

## Grievances and orders

Acknowledge from `grievance@blendn.app`, act with **Act** above, reply with what
was done. The product cannot reply to a person who reported in the app: their
only answer is the push when a report is acted on. Send a court order or
government notice to the grievance officer and `OWNER: name` at once. To answer
a data request, follow `docs/RETENTION.md` § Answering a legal request.

## Incident log

Every S1, S2 and grievance gets one Jira ticket under Epic SCRUM-1127 with these
columns. Never in this file: the repo is public.

| Date | Sev | What came in | Action | Who decided | Time to act |
|---|---|---|---|---|---|
| _(none yet)_ | | | | | |
