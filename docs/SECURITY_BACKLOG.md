# Security backlog

The standing ledger for security findings and the fixes applied to them.

**The rule.** Every finding lands here before it is fixed, and moves to
**Closed** in the same PR that fixes it, naming the commit. A finding that turns
out not to be real goes to **Validated — not an issue** with the reasoning, so
nobody spends a day rediscovering it. Nothing security-related ships without
this file moving.

Severity is about **what an attacker gets**, not how clever the bug is:

| | |
|---|---|
| **HIGH** | Directly exploitable: authentication bypass, privilege escalation, data breach, RCE |
| **MEDIUM** | Real, but needs specific conditions or yields less |
| **LOW** | Defence in depth. Worth doing, not worth waking anyone |

Related: `MODERATION_RESPONSE.md` is the human half of moderation --
severity, escalation and the incident log. `ROADMAP.md` is the feature ledger, `API.md` documents the endpoints,
and the app-side equivalent of this file is
`Blendn/SECURITY_RELIABILITY_BACKLOG.md` — mobile client findings live there and
are not duplicated here.

---

## Coverage — read this before trusting the absence of findings

A review that says nothing is either clean or incomplete, and the difference
matters. This is where that gets recorded honestly.

**Review of 2026-08-08 — complete.** A first attempt lost five of six sweeps to a
platform session limit and is superseded; the full pass below re-ran every
domain from scratch against `6bb16be`.

| Domain | Surface | Status |
|---|---|---|
| **Authorization & IDOR** | 53 mobile + 27 dashboard routes, all opened | ✅ 5 findings |
| **PII & data exposure** | every response shape, socket payloads, both privacy floors | ✅ 8 findings |
| **Authentication & session** | mobile JWT, NextAuth, OAuth, middleware, CORS | ✅ 4 findings |
| **Server actions** | 60 exports across 14 files, per-export | ✅ 1 finding |
| **Injection / uploads / SSRF** | 507 source files swept | ✅ 1 finding |
| **Sockets, crypto, cron** | handlers, randomness, both cron routes | ✅ **Clean** |

**Cleared, and worth recording so it is not re-audited:**

- **Both privacy floors hold.** `MIN_ATTENDEES = 8` takes a bare event id with
  no date-range or occurrence parameter plumbed to it, so there is no filtered
  cohort to narrow. `MIN_RATINGS = 4` guards `getTrustSignal`, which has **no
  production caller at all** — no trust band, average or harassment flag is
  reachable from any route. The trust boundary is intact.
- **Sockets.** `guardJoin` fails closed; `canJoinConversation` requires
  `user1_id`/`user2_id`, so you cannot read two other people's DMs. There are
  **no inbound message handlers** — every message event is server→client, so
  sender impersonation is not possible. `ops:snapshot` is gated per-event.
- **Injection.** All raw SQL is parameterised (`$queryRawUnsafe` in
  `events/search` uses positional `$1/$2/$3`). Exactly one computed Prisma key
  exists and both operands are `z.enum`. No `child_process`. No SSRF with host
  control — every outbound fetch has a hardcoded host. HTML emails escape every
  interpolation.
- **Crypto.** All real secrets use `crypto.randomBytes`; bcrypt cost 12; the
  one `Math.random()` is the per-event pseudonym, which is not security-bearing
  and carries no user-linkable input. Constant-time comparison on the leads
  token.
- **Cron.** Both routes fail closed when `CRON_SECRET` is unset. The dangerous
  sweepers — mass check-out, sentiment — have **no HTTP surface**; they run
  in-process.
- No password hash, refresh token or session token in any response. No stack
  trace, SQL or internal path echoed to a client.
- No route accepts `role`, `organizerId` or `organizer_org_id` from a body —
  there is no mass-assignment path to privilege escalation.

---

## Open

Tracked privately, in `Matryx-Social-Labs/blendn-ops` — **not** because they are
embarrassing, but because of what they are.

Both repositories are public, and that is right: obscurity is not a control, and
the moderation thresholds, geofence maths and rate limits are all readable in
the source regardless. `AUTO_HIDE_THRESHOLD` sits in `lib/moderation/config.ts`.
Removing that number from a document while the constant stays in a public file
would be theatre, so those stay documented here.

What is not derivable from source is **operational posture** — who is watching,
how quickly anyone responds, and which gaps we know about and have not closed.
That is useful only to somebody who wants to abuse a room without being stopped,
so it moves out for as long as it is unfixed.

The rule is narrow, and deliberately so:

> **A finding is private only while it is unfixed, and only when it describes
> response capability rather than code.**

Everything below is closed, and stays public with its reasoning intact — a fixed
bug explained is worth more to the next engineer than it is to an attacker.

---

### MEDIUM — deleting a category silently deletes every user's interest in it

**Found** 2026-08-12, by Codex during the Stage 2 plan review. Pre-existing;
Stage 2 raises the cost of it.

```prisma
model user_interests {
  category categories @relation(fields: [category_id], references: [id], onDelete: Cascade)
}
```

Deleting or merging a `categories` row cascades away every `user_interests` row
pointing at it. No warning, no confirmation of scope, no `audit_logs` entry, and
nothing that tells the affected people. An admin tidying the taxonomy — merging
two near-duplicate leaves, removing one nobody uses — destroys profile data
across every account that held it, and the only visible symptom is that those
people quietly stop matching on something they chose.

**Severity is honest, not inflated.** This ledger scores by *what an attacker
gets*, and an attacker gets nothing: the path needs dashboard admin rights, and
somebody with those can already do worse deliberately. It is here because it is
**silent, irreversible and triggered by a routine maintenance action** — the
combination that makes a bad afternoon into an unrecoverable one. Reading it as
HIGH would devalue the rows that actually are.

**Why Stage 2 makes it worse.** Interests used to be leaves only. Ranking now
expands a leaf to its parent (`lib/matches.ts`), so parents carry weight for
everyone under them — and deleting a *parent* nulls `parent_id` on its children
(optional relation, `SetNull`) rather than cascading, which is worse in a
different way: the leaves survive, the grouping vanishes, and the taxonomy
silently flattens for every room.

**The fix, when it is taken:**

- Refuse the delete when `_count.user_interests > 0`, and make the caller move
  them first — the same shape as refusing to delete an organisation with events.
- Or add a real merge: repoint `user_interests` at the surviving category
  (`skipDuplicates`, since a user may hold both), then delete.
- Either way, write an `audit_logs` row with the count. `lib/audit-log.ts`
  already exists for exactly this class of admin action.

**Not fixed in the Stage 2 PR (#210) on purpose.** It is a category-admin
concern rather than a matching one, and bundling a destructive-action guard into
a ranking change would put two unrelated risks in one review.

---

Everything the 2026-08-08 sweep found is closed below.

---

## Closed — 2026-08-10

### MEDIUM — a seed password hardcoded in a file that became public

`scripts/seed-room.ts` carried `const PASSWORD = "correct horse battery staple"`
as a constant. Both repositories were made public the same day, at which point
twenty-five accounts on `staging-api.blendn.app` had a password anyone could
read, with predictable addresses (`roomseed-aisha@blendn.invalid`) and the
hostname documented two directories away in `DEPLOYMENT.md`.

Staging is a separate database from production and holds only seeded fake data,
so nothing real was reachable — but it was an unauthenticated stranger's path to
a live API with a valid session, including the ability to send chat messages
into a seeded room.

**A hardcoded credential is only ever as private as the least private place the
code ends up**, and that is not a property you can check on the day you write
it. The rule this leaves behind: seeds take their password from the environment
with no default, like `seed-review-account.ts` already did.

Fixed: `SEED_ROOM_PASSWORD` is required and must be 12+ characters, the script
refuses to run without it, the password is re-asserted on every run so a leak
can be rotated by re-seeding, and the summary prints the variable name rather
than the value. The staging accounts were rotated to a fresh 28-character
password and the old one verified dead — signing in with it now returns 401.

The next pass should start where this one could not reach: **the mobile client**
(`Blendn/SECURITY_RELIABILITY_BACKLOG.md` tracks that half), and a re-read of
whatever ships next — a sweep is a snapshot, not a property.

Two things deliberately left as they are, with reasons:

- **A per-event opaque handle instead of the real user id.** Now defence in
  depth rather than a fix: `maySeeIdentity` means the id no longer buys anything.
  Worth doing eventually so an id cannot be correlated across events at all, and
  not worth churning the mobile contract for today.
- **CSP is report-only.** Enforcing it blind would break Swagger UI and the
  chart library. It needs a report endpoint and a week of data before the
  `'unsafe-inline'` and `'unsafe-eval'` come out.

## Closed

### 2026-08-10 — the group-chat report button now reports

**HIGH · fixed in Blendn#44**

The Report action showed a confirmation tray, fired a **success** haptic, and
called nothing. The room where abuse is most likely had a report button that
silently did nothing and actively told the user it had worked — worse than no
button, because they believe they reported it, nobody was told, and they
conclude we ignored them.

Fixed by reuse rather than new code: `showMessageReportOptions` in
`lib/safetyUtils.ts` already did this correctly and `app/private-chat` already
used it. The group screen had simply never imported it.

**Two bugs, not one.** The handler cleared `selectedMessage` *before* showing
the tray, so any callback would have seen it already gone. Wiring the API call
without capturing the id first would have reported `undefined` and looked like
it worked. The type checker then caught the second half — `Message` has no `id`,
the field is `message_id` — which would have been the same silent-undefined
failure.


### 2026-08-08 — the backlog's remaining items

**Fixed in `fix/identity-gate`.** Everything left open by the sweep.

**Pseudonymity is no longer one request deep** (was the top HIGH). Every room
surface hands out the real user id — the client needs it to block, report and
open a message request — and `GET /users/:id` would exchange any id for a real
name and photos. Two requests de-anonymised a whole room, and the same join
attributed every "anonymous" chat message to a named person.

The obvious fix was a per-event opaque handle, and it was the wrong first move:
the id is in the mobile contract everywhere. **The id was never the secret; the
lookup was.** `lib/identity.ts` gates identity on a relationship — you matched
(mutual like at one event), you are in a conversation, or they chose to be
public in a room you were in. Co-presence alone is deliberately not enough:
sharing a room is what lets you send a request, not consent to be identified.
Withheld fields are absent rather than null, and `occupation`/`education` go
with the name because "Principal @ Arclight Labs" identifies about as well as a
photograph. Applied to `users/:id` and `profiles/:id`.

`interested-users` returned `{real id, real name, real photo}` in bulk to any
caller, which would have made the gate decorative — it now returns avatars only,
matching the shape `events/route.ts` already used.

Nine cases pinned in `__tests__/integration/identity-gate.itest.ts` against a
real database, including the four ways in that must **not** work: a stranger, a
room-mate, a one-sided like, and two likes at different events.

**Export pseudonyms are an HMAC** (`lib/pseudonym.ts`). They were
`attendee-${userId.slice(0, 8)}` — an abbreviation, not a pseudonym. The same
host is handed full user ids for chat participants, so prefix-matching recovered
who each export row was, and linked the same attendee across every event they
run. Now keyed on `NEXTAUTH_SECRET` and salted per organisation, so two hosts
cannot compare notes either. Salted per org rather than per event because the
attendees report counts events per person and needs the label stable across
them.

**The two event write routes have a schema** — `eventWriteSchema` on
`POST /api/events` and `PATCH /api/events/[id]`, the last writes in the codebase
without one. They destructured 37 fields as their allow-list, so mass assignment
was never possible, but nothing bounded a string or checked that `latitude` was
a number, and `parseJsonField` put unvalidated `JSON.parse` output into Json
columns. The type checker immediately found the routes were also using the raw
body rather than the parsed data, which would have made the schema decorative.

**Moderation flag scoped to its event** — `canOperate` was checked against the
event in the URL and the flag then loaded by id alone, so a host could un-hide a
message in another organisation's room. Needed a UUID guess, so never practically
reachable; the sibling route already carried the predicate.

**Venue claim evidence is validated.** `ClaimEvidence` is a TypeScript interface
and erased at runtime, so URLs arrived unchecked from a server-action argument
and rendered into an `<a href>` for a reviewing admin. React 19 blocks
`javascript:`, which is the only reason it was never exploitable. Validation
sits **after** the role check — someone who may not file at all should be told
that, not handed a critique of their input.

**HSTS and a report-only CSP.** HSTS is enforcing (two years, preload); CSP
reports only, because enforcing it blind would break Swagger UI and the chart
library. Removing `'unsafe-inline'`/`'unsafe-eval'` needs a report endpoint and
a week of data first.

### 2026-08-08 — the full-sweep findings

**Fixed in `fix/security-sweep`.** Eleven issues across five domains.

#### HIGH

**Account pre-hijacking through OAuth email linking** — `lib/mobile-auth.ts`.
`POST /auth/signup` creates a `User` from any email with no proof of ownership
(no verification mail, `emailVerified` left null), and both OAuth paths resolved
an unknown provider `sub` by looking the email up and silently linking to
whatever row they found. So: attacker signs up as `victim@gmail.com` with a
password of their choosing; the victim later taps "Continue with Google", their
token is genuine, the email matches, and they are logged into the **attacker's
row** — where they onboard, check in and send DMs; the attacker then signs in
with the password from step one. Fixed by `linkVerifiedOAuthIdentity`: when the
existing account never proved ownership, the OAuth identity wins — the address
is marked verified and the password credential is dropped, evicting the squatter
at the cost of one password reset for a legitimate unverified user.

**Google audience check failed open** — `lib/mobile-auth.ts:326`. The guard read
`GOOGLE_CLIENT_IDS.length > 0 && !includes(aud)`, and all three client-ID vars
are optional and undeclared in `lib/env.ts`. With none set, `aud` — the only
claim tying a Google token to *us* — went unchecked, so any token Google ever
issued to any app would authenticate. Now returns null and logs an error when
nothing is configured.

> **Follow-up, 2026-08-10.** Setting the client ids on Railway exposed a
> separate, pre-existing fault: only `GOOGLE_IOS_CLIENT_ID` was set on staging
> *and* production. The native Google SDK audiences its id token to the **web**
> client id, so `aud` never matched and Google sign-in had been failing for
> every mobile user — under the old `length > 0` guard just as much as the new
> one, since one id is still a non-empty list. Not caused by the fix above.
>
> All three ids are now set on both environments. The lesson is the silence:
> the health check was green, email sign-in worked, and the only trace was a
> `Google token audience mismatch` warning that reads like an attacker. Two
> changes so the next one announces itself — `googleSignInConfigWarning()` in
> `lib/env.ts`, warned at boot from `server.ts` (a warning, never a throw: an
> email-only deployment is legitimate), and the mismatch log now carries the
> received and configured audiences so misconfiguration is distinguishable from
> a replayed token. Client ids ship in the app binary, so logging them leaks
> nothing.

**Audit log scope overwritten by a caller-supplied filter** —
`lib/audit-actions.ts:80`. The tenant scope wrote `where.user_id`, then
`filters.actorId` wrote the same key. Since action arguments are
attacker-controlled JSON however they are typed, `{ not: null }` arrived as a
Prisma operator and unscoped the query entirely — the platform-wide audit trail,
with other companies' owners' names and email addresses in the details. Rebuilt
as an `AND` array so a filter can only narrow, with `typeof` guards so an object
cannot become an operator.

**`GET /api/events/[id]` was unauthenticated** — the sibling PATCH and DELETE
both run `eventPermissions`; GET did neither, and `middleware.ts` does not match
`/api/events`, so nothing gated it. It returned the entire row for any event id
— drafts, private events, and the `geofence` / `check_in_radius`, which is the
server-side check-in boundary. Reading it tells you which coordinates to submit
to pass `evaluateCheckIn` from anywhere, which turns the guarantee every
organiser number rests on into a formality.

**Organiser CSV export shipped attendee name, email and phone** —
`checkins/export`. `lib/reports.ts` states outright that "an organiser sees who
came to their events… and never an email address" and that "an export is not a
way around" pseudonymity. This route was the way around it, and returned
strictly more than the screen it backs. Now exports pseudonyms via the shared
`lib/csv.ts` helper — which also fixes **CSV formula injection**, since the
route hand-rolled RFC 4180 quoting with no formula neutralisation, so an
attendee could set their display name to `=HYPERLINK(...)` and have it execute
in the organiser's spreadsheet.

**Dashboard moderation queue leaked real name and email to hosts** —
`app/api/events/[id]/chat/moderation/route.ts`. Gated on `canOperate`, which is
organiser and venue owner — not admin. The sibling `chat/messages` route was
fixed for exactly this and this one was missed, so any host could read the real
identity of every "anonymous" attendee who had ever been auto-flagged, with the
pseudonym on the adjacent tab keyed to the same id. Now returns
`anonymousName`, with name and email admin-only and **absent** rather than null.

#### MEDIUM

**Every organiser's unpublished drafts were listable** —
`app/api/mobile/events/route.ts:122`. `status` was caller-supplied and the schema
accepts `"draft"`, with no ownership scoping in the handler. Since `status`
defaults to `draft` and `visibility` to `public`, every event was a public draft
from creation until publication, so `?status=draft` returned every unannounced
event on the platform. Discovery now pins `published`.

**Attendee roster readable without attending** — `checkins/route.ts`. Every
sibling room surface requires a check-in; this one authenticated and handed over
a timestamped guest list. Now gated on the caller's own check-in.

**IDOR on `users/[userId]/favorites`** — the path id drove the query and the
token was used only to prove someone was logged in. The default
`timeFilter=upcoming` returns future events with venue, address and coordinates:
where a named person intends to be, and when. Scoped to self.

**`profiles/[userId]` used a deny-list and had no block check** — it spread the
whole `profiles` model and deleted five fields, shipping `gender`,
`interested_in`, `goals`, `looking_for`, `intent_default` and `reveal_by_default`
to any caller — the first two collected "only when intent includes dating", per
the schema's own comment. And unlike `users/[userId]` it had no
`blockedEitherWay`, so a block was bypassed by swapping `/users/` for
`/profiles/` in the URL. Now an explicit allow-list plus the block check.

**Role revocation did not take effect** — `lib/auth.ts`. With the JWT strategy
there is no session table to clear and the default session is 30 days; the `jwt`
callback wrote `role` only at sign-in. A demoted admin kept `app_admin` in a live
cookie for up to a month, and could re-promote themselves to make it permanent.
`lib/socket-ops-auth.ts` already re-read the role per connection for this exact
reason; the HTTP path was the one left on the stale claim. Now re-read per
request, failing closed to `attendee`.

#### Not a vulnerability, found while sweeping — and shipped broken

**The live operations room never worked.** `lib/socket-server.ts:594` — the
`join:eventOps` and `leave:eventOps` handlers were written **inside** the body of
the `leave:event` callback, one missing brace. They therefore did not exist
until a client emitted `leave:event`, and the ops hook emits `join:eventOps` on
connect and never emits `leave:event` at all. So `ops:snapshot` fired for nobody
and the live dashboard sat empty, while every `leave:event` stacked another
duplicate listener pair. It compiles, it lints, and the socket tests exercise the
`canJoin*` predicates rather than whether anything is wired to them — the
authorisation was never wrong, the handler holding it was unreachable.
`__tests__/socket-handler-registration.test.ts` now fails if any handler is
nested inside another.

### 2026-08-08 — four server actions authorised at the view layer only

**HIGH · privilege escalation · fixed in `fix/server-action-authz`**

Found by auditing all 16 `"use server"` files.

**The mistake, once, in four places.** A `"use server"` export is a POST
endpoint. Next dispatches it by action id, and the page component is **not in
the request path** — so a `role !== "app_admin"` redirect in `page.tsx` guards
the *view* and never the *data* behind it. Four exports relied on precisely
that.

| Action | What an organiser or venue owner could read |
|---|---|
| `app/dashboard/actions.ts:733` `getDashboardOverview(role, userId)` | `role` was an **argument**. Passing `"app_admin"` returned the whole-platform report: user totals, growth series, the signup→check-in funnel, the moderation backlog, and **every organiser's name and email**. Passing another organiser's id returned their pacing, capacity, no-show rate and drafts |
| `app/dashboard/actions.ts:753` `getEventRows(userId?)` | The scope argument was **optional**. Omitting it widened the query to the 100 most recent events **platform-wide, every organiser, drafts included** |
| `app/dashboard/moderation/actions.ts:47` `getModerationQueue` | Up to 100 flagged **private chat messages** — content, the author's **real name and email**, and the event. `resolveFlag` directly below it checks for `app_admin`; the read half of the same screen did not |
| `app/dashboard/users/actions.ts:121` `getUserById` | Any user's `email`, `phone`, `age`, `location` and `role` by id. Every other export in that file checks `app_admin`; this one was missed |

Chainable: the first yields organiser ids, the fourth turns them into phone
numbers and home cities.

**Not unauthenticated.** The initial report claimed no cookie was required; that
was wrong, and the distinction is the whole severity. `middleware.ts:175`
requires a session for `/dashboard/:path*` and `canAccessDashboard` rejects
attendees. The real bar is **any approved organiser or venue owner** — external
customers who sign up through `/apply`. Still a straight crossing of the RBAC
boundary, still HIGH.

**Also checked and not exploitable from outside:** the four action ids are
absent from every client chunk in `.next/static` (verified against
`server-reference-manifest.json`), because no client component imports them. The
ids of the *guarded* actions — `updateUser`, `updateUserRole`, `deleteUser`,
`resolveFlag` — do appear, since client forms use them. So discovery required
source access or id derivation. That is obscurity, not a control, and it would
have evaporated the first time one of these was called from a client component.

**Fixed by removing the ability rather than adding a check.**
`getDashboardOverview` and `getEventRows` no longer take `role` or `userId` at
all — both are read from the session inside the action, so there is no argument
left to lie in. The other two gained the `app_admin` check their siblings
already had.

**Since superseded for three of the four: they were deleted.** `getEventRows`,
`getUserById` and `toggleUserOnboarded` turned out to have **zero callers** —
the events screen fetches `/api/events`, the users table already carries the
fields `getUserById` returned, and `updateUser` already writes `onboarded`. So
each was a second answer to a question something else was already answering,
and the session-scoping fix above was hardening a path nobody could reach.
Recorded rather than quietly dropped, because a security note describing a
control on a function that no longer exists is the lying-comment pattern this
audit has now counted eighteen times.

They were invisible until `server-actions-reachable.test.ts` was widened to
scan `"use server"` files under `app/`, having previously scanned `lib/` alone
— which is the blind spot W16 already recorded and did not close.

**Guarded by `__tests__/server-action-authz.test.ts`**, which asserts the *shape*
— every `"use server"` file must read the session — rather than the four
instances. Verified to fail when a session read is removed. It cannot prove a
check is *correct*, only that the data layer does not delegate authorisation
entirely to a page it never runs behind.

### Earlier

Recorded from git history so this file is the whole story, not just the part
written after it existed.

| | |
|---|---|
| **0.56.0** (#170) | Four preference booleans were returned to any authenticated caller — `GET /profiles/:userId` stripped `phone` and nothing else, so whether you share your location was public |
| **0.46.0** (#159) | Seven identity and DM holes: the attendee list handed out every attendee's real name and photo while every other view returned a pseudonym; `POST /conversations` opened a DM from two user ids and nothing else; "block" wrote no block; the send path checked one direction of it; the two conversation-creation paths ordered the pair differently so the unique constraint could be evaded; message requests had no co-presence test; `goals`/`looking_for` survived account deletion |
| **#98** | The mutating API had no rate limiting; counters moved to Redis |
| **#86** | Attendee identity leaked to event hosts |

---

## Validated — not an issue

*Empty. Entries go here with the reasoning when something looks like a finding
and is not, so it is not re-audited every pass.*

---

## Standing invariants, and the tests that hold them

These are the security properties the product actually rests on. Each has a test
that fails the build, because a privacy guarantee maintained by memory is not
one.

| Invariant | Test |
|---|---|
| Peer ratings never reach the person rated — no mobile route may even import the trust module | `__tests__/trust-not-exposed.test.ts` |
| Rooms are pseudonymous; real names and photos only on mutual reveal | `__tests__/chat-identity.test.ts` |
| Mobile JWT verification and refresh rotation | `__tests__/mobile-auth.test.ts` |
| Socket connections authenticate and rooms are scoped | `__tests__/socket-auth.test.ts` |
| Every `"use server"` file reads the session | `__tests__/server-action-authz.test.ts` — **weaker than it looks, see below** |
| No socket handler is nested inside another | `__tests__/socket-handler-registration.test.ts` |
| Trust bands, volume floors, harassment never averaged away | `__tests__/trust.test.ts` |

**`server-action-authz.test.ts` would not have caught the bug it was written
for**, and that is worth stating rather than quietly relying on it. It checks
that a *file* contains a session read somewhere. Pre-fix,
`app/dashboard/users/actions.ts` had six guarded exports and one unguarded one,
so the file would have passed. The same is true of the moderation file, where
`resolveFlag`'s check would have covered for `getModerationQueue`.

It is kept because no file is mixed today and it catches a wholly unguarded new
file cheaply. It should be replaced by a per-export version — walk each
`export async function` body and require the guard before the first `db.` call
— which is a similar amount of code and would actually bind. Its other blind
spots: it matches a fixed list of helper names, and it never sees function-level
`"use server"` directives (none exist today).

Aggregates have privacy floors so a number cannot name a person:
`MIN_ATTENDEES = 8` (`lib/connection-metrics.ts`), `MIN_RATINGS = 4`
(`lib/trust.ts`). Both were traced this pass and hold — neither takes a
caller-supplied filter that could narrow the cohort below the floor.

---

## How to add an entry

1. Put it under **Open** with severity, `file:line`, and a concrete exploit
   scenario — who calls what, and what they get. "Could be dangerous" is not a
   finding.
2. Fix it and add a test that fails without the fix. Prefer a test that guards
   the *class*: the four findings above were one mistake in four places, and a
   test naming four functions would not have caught the fifth.
3. Move it to **Closed** in the same PR, with the branch or commit.
4. If it turns out not to be real, move it to **Validated — not an issue** with
   the reasoning. That is worth as much as a fix.
