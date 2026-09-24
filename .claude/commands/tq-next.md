---
description: Take the next unit from the Blendn test queue, drive it end to end on its surfaces, file what you find, and close or release it
argument-hint: "<session-tag> [SCRUM-key to take a specific unit] [lane A|B|C]"
---

You are one session in a shared test programme. Other developers and sessions
are working the same queue and the same staging at the same time. The rules in
`docs/agents/TEST-PLAN.md` are not optional — read §1–§5 now if you have not in
this session. The method (what "tested" means) is `docs/TESTING-PLAYBOOK.md` §8.

Arguments: $ARGUMENTS  — session tag first (e.g. `sk-0924a`), then optionally a
unit key and a lane. No tag → stop and ask for one.

Do **one unit** per run, completely. Then stop and report — the developer runs
`/tq-next` again for the next one.

## 1 · Sync and look

1. `git fetch` this repo and the client repo; work from `origin/dev`.
2. `caffeinate -dimsu &` if not already running (the host sleeping mid-run has
   been mistaken for staging hanging).
3. `npm run -s qa bootstrap` (if `~/.blendn-qa/pgurl` is missing) and
   `npm run -s qa world`. Note whether an event is live.

## 2 · Pick and claim

1. If a key was given, take it. Otherwise query Jira, narrowly (fields
   `summary,status,labels,priority`, ≤ 20 results), in this order:
   - `labels = tq-verify AND status = "In Review"` — merged fixes nobody drove yet;
   - then `labels = tq AND status = "To Do" AND type = Task ORDER BY priority DESC, key ASC`.
   Skip a unit this machine can't do: `needs-live-event` with nothing live (unless
   you refresh — below), `needs-real-device` without one, a surface with no
   device here.
2. No live event and the unit needs one → `--refresh-times` per TEST-PLAN.md §4
   (safe with others testing) and log it on SCRUM-208.
3. Claim (TEST-PLAN.md §2): In Progress · label `claim-<tag>` · comment
   `CLAIMED <tag> <UTC> — surfaces: … — lane: …`. **Re-read the ticket**; an
   older claim wins — yield and pick another.
4. Lane: if the unit uses attendees, take a free lane — post
   `LANE <A|B|C> → <tag>` on SCRUM-208 unless the latest comment for that lane
   is a claim by someone else without a `LANE … released`.
5. Lock the device(s) you'll drive: `npm run -s qa lock <device> <tag>`.

## 3 · Drive it

Follow the unit's charter — the happy path **and** every refusal path it names.
Use the tool each surface needs:

| Surface | How |
|---|---|
| iOS / Android app | Maestro MCP (`list_devices` → `inspect_screen` → `run`), or the Maestro CLI with the journeys in `blendn/.maestro/`. Credentials only via `-e`. After typing, the keyboard's bottom-right key (`keyboard-done` subflow). iOS first, then shut it and do Android. |
| Dashboard | gstack **browse**, signed in as the role the unit names. |
| Mobile API | `curl` with `$(npm run -s qa token <email>)` — never sign in by hand (5 per IP per 15 min, successes count). |
| Sockets | `npm run -s qa probe <chatGroupId> <email> [s] [--post-as <email> <text>]`. |
| Background jobs | arrange the rows, wait a tick, `railway logs --environment staging --service Blendn-Admin`. |
| Email | the Resend API log (key from Railway, never printed). |

**Read back every write:** `npm run -s qa sq "SELECT …"`. An API 200 is not a row.

Post progress comments on the unit as you go (what step, what you saw).

## 4 · What you find

Each defect is **its own ticket**: summary with severity (`P1 SECURITY:`,
`P2:`, …), steps, what happened vs what should, the read-back, file:line when
known, labels = its `surf-*` + `found-in-<unit key>`, parent = the unit's Epic.
Use gstack **investigate** when the cause isn't obvious.

Then decide, and say which you chose:
- **Fix now** — P1, security, data loss, or a small fix wholly inside this
  unit's area → run `/tq-fix <new key>` after finishing this unit, or tell the
  developer to.
- **File and move on** — everything else.

## 5 · Close or release

- Driven on every surface the unit names, rows read back, findings filed →
  post the §8 line (TEST-PLAN.md §5), add `driven-ios` / `driven-android` as
  earned, move to **Done**, remove `claim-<tag>`.
- Waiting on a fix → **In Review**, with the finding keys.
- Couldn't finish → `RELEASED <tag> — resume at step N — state: …`, back to
  **To Do**, remove the label.
- Put back anything you changed on shared fixtures (memberships, bans,
  suspensions), `npm run -s qa unlock <device>`, and release the lane on
  SCRUM-208 (`LANE <x> released`) if you're stopping.

## 6 · Report

End with five lines: the unit and its new status · what was driven, per
surface · what was read back · findings filed (keys, severity) · what the
developer should run next (`/tq-next <tag>`, or `/tq-fix <key>`).
