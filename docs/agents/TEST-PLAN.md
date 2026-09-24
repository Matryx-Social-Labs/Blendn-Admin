# The test programme — a queue every session works from

**Start every testing session here.** The method is in
[`TESTING-PLAYBOOK.md`](../TESTING-PLAYBOOK.md) (§8 decides what "tested" means)
and the operating detail in [`routines/`](routines/) and
[`reference/environment.md`](reference/environment.md). This file is only the
programme: what the units are, how a session takes one, and how sessions stay
out of each other's way.

**Progress lives in Jira, not here.** This file changes when the method does;
the queue changes every hour.

---

## 1 · The queue

Every unit of testing is a Jira Task labelled `tq`, under one of these Epics.

| Epic | What it holds |
|---|---|
| [SCRUM-209](https://matrixsociallabs.atlassian.net/browse/SCRUM-209) TQ-V | Merged fixes waiting on a drive: the In Review tickets. **Priority 0.** |
| [SCRUM-210](https://matrixsociallabs.atlassian.net/browse/SCRUM-210) TQ-C | Attendee journeys in the app, on iOS **and** Android |
| [SCRUM-211](https://matrixsociallabs.atlassian.net/browse/SCRUM-211) TQ-DA | Dashboard as `admin@` |
| [SCRUM-212](https://matrixsociallabs.atlassian.net/browse/SCRUM-212) TQ-DO | Dashboard as `organizer@`, plus the no-org control `daniel.weber@` |
| [SCRUM-213](https://matrixsociallabs.atlassian.net/browse/SCRUM-213) TQ-DV | Dashboard as `venue.owner@`: operate, never edit |
| [SCRUM-214](https://matrixsociallabs.atlassian.net/browse/SCRUM-214) TQ-DS | Dashboard as `sponsor@` |
| [SCRUM-215](https://matrixsociallabs.atlassian.net/browse/SCRUM-215) TQ-P | Public pages: apply, claim, sign-in and reset, API docs |
| [SCRUM-216](https://matrixsociallabs.atlassian.net/browse/SCRUM-216) TQ-A | Mobile API: auth, the wrong-user sweep, contract, limits, uploads |
| [SCRUM-217](https://matrixsociallabs.atlassian.net/browse/SCRUM-217) TQ-S | Sockets: join rules, delivery, eviction, presence |
| [SCRUM-218](https://matrixsociallabs.atlassian.net/browse/SCRUM-218) TQ-B | Background jobs |
| [SCRUM-219](https://matrixsociallabs.atlassian.net/browse/SCRUM-219) TQ-E | Email, read back from the Resend log |
| [SCRUM-220](https://matrixsociallabs.atlassian.net/browse/SCRUM-220) TQ-X | Security sweep, performance, accessibility, privacy, responsive |

[SCRUM-208](https://matrixsociallabs.atlassian.net/browse/SCRUM-208) is the
**staging world log**: read it before you re-seed or change a shared fixture,
and write to it when you do.

**Order:** TQ-V → the `Highest`/`High` units (the access sweeps A02, X01, S03;
auth; check-in; the room) → the rest by priority → TQ-X.

### Status is the queue state

| Status | Means |
|---|---|
| To Do | Queued |
| In Progress | Claimed by a session (see §2) |
| In Review | Driven; a fix is open, or the unit is waiting on one |
| Done | Driven on every surface it names, the rows read back, every finding filed |

### Labels

| Label | Meaning |
|---|---|
| `tq` | In the programme. Epics also carry `tq-epic`; the In Review set carries `tq-verify` |
| `surf-ios` `surf-android` `surf-dash-admin` `surf-dash-org` `surf-dash-venue` `surf-dash-sponsor` `surf-public` `surf-api` `surf-socket` `surf-cron` `surf-email` | The surfaces a unit must be driven on |
| `needs-live-event` | Can only run while an event is live on staging (§4) |
| `needs-real-device` | Push, Google/Apple sign-in, real GPS: not a simulator |
| `destructive` | Suspends, deletes, bans or rotates: only ever on fixtures **your session created** |
| `driven-ios` `driven-android` | Progress on a client unit; it closes with both, or an explicit "not driven — reason" |
| `claim-<tag>` | Which session holds it (§2) |
| `found-in-SCRUM-N` | On a finding: the unit that found it |

### Views (paste into Jira search)

```
Next up:        project = SCRUM AND labels = tq AND status = "To Do" AND type = Task ORDER BY priority DESC, key ASC
Verify first:   project = SCRUM AND labels = tq-verify AND status = "In Review" ORDER BY priority DESC
Claimed now:    project = SCRUM AND labels = tq AND status = "In Progress"
Needs a live event:  project = SCRUM AND labels = tq AND labels = needs-live-event AND status != Done
Found by the programme:  project = SCRUM AND labels ~ "found-in-*"   (or search text "found-in-SCRUM")
One surface:    project = SCRUM AND labels = tq AND labels = surf-android AND status != Done
```

Keep Jira queries narrow: ask for `summary, status, labels` and ≤ 20 results.
A 60-issue search with full descriptions overflowed the tool once, and one
unscoped search hung for ten minutes.

---

## 2 · Claiming a unit

Every session uses the same Jira account, so the assignee can't tell sessions
apart. Claim with a **session tag**: short, unique, e.g. `s-0924a` (date plus a
letter), or your worktree name.

1. Pick the top of *Next up* that your machine can drive (a device, a live event).
2. Move it to **In Progress**, add the label `claim-<tag>`, comment
   `CLAIMED <tag> <UTC time> — surfaces: … — lane: …`.
3. **Re-read the ticket.** If another claim comment is older than yours, back
   off: remove your label, comment `yielded to <their tag>`, pick another.
   (Jira moves aren't atomic; this is the lock.)
4. Comment progress as you go: which step, what was found.
5. A claim with no comment for **6 hours** is stale: take it over with a comment
   naming the old tag.
6. Leaving unfinished: comment `RELEASED <tag> — resume at step N — state: …`,
   move it back to **To Do**, remove your label.

---

## 3 · Accounts, and not trampling each other

The password for every account below is `SEED_PASSWORD` on Railway staging
(`Blendn-Admin`). Read it with
`railway variables --environment staging --service Blendn-Admin`. Never write it
to a file, a flow or a ticket.

**Dashboard roles (shared, re-asserted on every deploy by `scripts/test-accounts.ts`):**
`admin@` · `organizer@` (Nightshift Collective) · `venue.owner@` (Indiranagar
Hospitality Group) · `sponsor@` (Blue Tokai). Read and operate freely. **Never
change their password, role or org** — every session depends on them.

**Attendee lanes.** Two sessions driving the same attendee overwrite each
other's rooms, bans and profile edits. Take a lane and state it in your claim:

| Lane | Attendees |
|---|---|
| A | `ananya.b@`, `rohan.d@` |
| B | `vikram.s@`, `kavya.n@` |
| C | `sneha.p@`, `imran.q@` |

Lanes are held across machines, so they're claimed where every machine can see
them: a comment on SCRUM-208, `LANE B → <tag>`, and `LANE B released` when
you stop. The latest comment for a lane decides who holds it. Device locks
(`qa lock`) are local files and only keep sessions on one machine apart.

**Shared controls, read-only:** `teen.tester@` (16, the minor), `daniel.weber@`
(organiser with no org). **Never touch** `appreview@` (the App Store reviewer).

**Destructive work** (suspend, delete, ban, password change, role change) goes
on a person **your session created**: sign one up through the app as
`qa.<tag>.<n>@blendn.app`, or through the dashboard. Put anything you changed
back before you release the unit.

**Sign-in is limited to 5 per IP per 15 minutes, and a success counts.** Every
session on one machine shares that budget. Use `npm run -s qa token <email>`: it
caches the token and refreshes it instead of signing in again.

---

## 4 · The world: live events and re-seeding

Seed event times are set when the seed runs, so a live event only exists for a
few hours after a re-seed. Check first:

```bash
npm run -s qa world     # live now and within 48 h, odd room memberships, device locks
```

**No live event? Refresh the times — this is safe with others testing:**

```bash
RAILWAY_ENVIRONMENT_NAME=staging DATABASE_URL="$(cat ~/.blendn-qa/pgurl)" \
  npx tsx scripts/seed-qa.ts --refresh-times
```

It moves every seeded event back to its offset from now (Founders & Filter
Coffee is live for the next ~2.5 h) and reopens a room the archive sweep closed.
Nothing else changes: memberships, bans, profiles, claims stay as they are. Post
one line on SCRUM-208.

**A full re-seed (`--apply`) resets memberships and moderation state.** Run it
only when no unit labelled `needs-live-event` is In Progress (the *Needs a live
event* view), and log it on SCRUM-208 with `npm run -s qa world` from after:

```bash
SEED_PASSWORD="$(railway variables --environment staging --service Blendn-Admin --json | jq -r .SEED_PASSWORD)" \
RAILWAY_ENVIRONMENT_NAME=staging \
DATABASE_URL="$(cat ~/.blendn-qa/pgurl)" npm run seed:qa -- --apply
```

Every seeded person shares `SEED_PASSWORD`: the deploy step re-asserts it on
the role accounts **and** on `SEED_PERSONAS` (the attendees, named admins, the
no-org control), so a rotation on Railway reaches all of them on the next deploy.

---

## 5 · A session, start to end

**Start**
1. `git fetch` both repos; work from `origin/dev`.
2. `caffeinate -dimsu &`. The Mac went to sleep mid-run on 2026-09-24 and every
   "hang" that night was the host, not staging. Keep it on power, lid open.
3. `npm run -s qa bootstrap`: staging DB URL into `~/.blendn-qa/pgurl` (600).
   Scratch lives there, not in `/tmp`, which macOS purges.
4. `npm run -s qa world`.
5. Claim a unit (§2). Lock the device you'll drive:
   `npm run -s qa lock ios-<udid> <tag>` / `npm run -s qa lock android-emulator-5554 <tag>`.
   **One device per session; iOS first, then shut it and do Android** (host load).

**During**
- Follow the unit's charter: the happy path **and** the refusal path.
- Client: Maestro (MCP, or the CLI when the MCP is down) with the flows in
  `blendn/.maestro/`. After typing, tap the keyboard's bottom-right key.
- Dashboard: gstack `browse`, signed in as the role the unit names.
- API: curl with `$(npm run -s qa token <email>)`.
- Sockets: `npm run -s qa probe <chatGroupId> <email> [seconds] [post-as <email> <text>]`.
- Read every row back: `npm run -s qa sq "SELECT …"` (read-only by construction:
  writes go through the product).
- A finding is its **own** ticket, labelled `found-in-<unit key>` and its
  surfaces, with steps, the read-back and the file:line when known.

**End**
1. Post the §8 line on the unit:
   ```
   8 · Driven:     <iOS flow + result> | <Android flow + result> | <dashboard journey>
       Read back:  <the SELECT, and what it returned>
       Or:         not driven — <reason>, and the unit stays open
   ```
2. Add `driven-ios` / `driven-android`; move to Done only when §1's definition holds.
3. `npm run -s qa unlock <device>`. Leave nothing half-banned or suspended.

---

## 6 · The unit template

Every `tq` Task description has the same parts, so a session can start cold:

```
Surfaces · Accounts · Needs
Charter      numbered steps, happy path first
Refusal paths
Read back    the exact SELECTs
Done when    the §8 line, per surface
```

A new unit (a surface nobody queued) gets the same template, the `tq` label,
its `surf-*` labels, and the right Epic as parent.

---

## 7 · Tools this programme added

| Tool | Where | Notes |
|---|---|---|
| `npm run -s qa …` | `scripts/qa.ts` | bootstrap · sq · token · world · probe · lock/unlock. Staging or localhost only; queries run `READ ONLY` |
| Maestro flows | `blendn/.maestro/` | Parameterised with `-e`; no credentials in any file |
| World log | SCRUM-208 | Every re-seed and shared-fixture change |

---

## 8 · A new developer, and more than one of you

The routine is in three slash commands in `.claude/commands/`, so nobody has to
remember it. In Claude Code, from this repo:

| Command | When |
|---|---|
| `/tq-setup <initials>` | Once per machine. Checks the repos, CLIs, the Railway login and `SEED_PASSWORD`, the atlassian and maestro MCP servers, and the skills and agents the programme uses (gstack, ECC); lists what's missing. |
| `/tq-next <tag> [SCRUM-key] [lane]` | Again and again. One unit per run: sync, pick (TQ-V first), claim, drive every surface, read back, file findings, close or release, report. |
| `/tq-fix <SCRUM-key> <tag>` | For a finding worth fixing now. Root cause, failing test first, mutation + register, specialist reviews, PR, merge, staging, then drive the fix where it was found. |

So a working session is:

```
/tq-setup sk                 # first time on this machine
/tq-next sk-0924a            # a unit, end to end
/tq-fix SCRUM-290 sk-0924a   # if it found something to fix now
/tq-next sk-0924a            # the next unit (fixed tickets come back through TQ-V)
```

`/loop /tq-next sk-0924a` repeats it unattended. Only do that on a machine
kept awake and on power, and read the reports: every run claims, drives and
files on shared staging.

**Several developers at once.** Everything shared is coordinated in Jira, so
it works across machines:

- **Session tags** are unique per person and session: `<initials>-<MMDD><letter>`.
- **Units**: the claim protocol (§2) keeps two people off one unit.
- **Attendees**: one lane per person, claimed on SCRUM-208 (§3). Three lanes →
  three people driving the app at once; a fourth works the dashboard, API,
  sockets or jobs units, which need no lane.
- **Shared accounts**: the four role accounts are read-and-operate for everyone.
  Nobody changes their password, role or org.
- **The world**: `--refresh-times` is safe any time; `--apply` only per §4.
- **Sign-in limit** is per IP, so it's per machine — each developer has their own
  5 per 15 minutes, shared by their own sessions.
- **Fixes**: `/tq-fix` comments `FIXING <tag>` first; promotion to staging is
  fast-forward only, so a push rejected because someone promoted first means
  fetch and look, never force.
