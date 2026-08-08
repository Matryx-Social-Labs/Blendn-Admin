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

Related: `ROADMAP.md` is the feature ledger, `API.md` documents the endpoints,
and the app-side equivalent of this file is
`Blendn/SECURITY_RELIABILITY_BACKLOG.md` — mobile client findings live there and
are not duplicated here.

---

## Coverage — read this before trusting the absence of findings

A review that says nothing is either clean or incomplete, and the difference
matters. This is where that gets recorded honestly.

**Review of 2026-08-08 — partial.** Six parallel sweeps were commissioned across
the full backend. **One completed; five were killed mid-run by a platform
session limit.** What follows is therefore *one domain reviewed properly* and
five *started and abandoned*. The unreviewed domains are not clean — they are
unexamined.

| Domain | Surface | Status |
|---|---|---|
| **Server actions** | 16 `"use server"` files | ✅ **Complete** — 4 findings, all fixed |
| Authentication & session | `lib/mobile-auth.ts`, `lib/auth.ts`, `middleware.ts`, 8 auth routes | ⛔ **Not reviewed** — killed early |
| Authorization & IDOR | 53 mobile + 27 dashboard routes | ⛔ **Not reviewed** — killed early |
| Injection | 4 raw-SQL files, uploads, SSRF | 🟡 **Partial** — raw SQL confirmed parameterised; everything else unexamined |
| PII & data exposure | every response shape, socket payloads | ⛔ **Not reviewed** — killed with "one candidate" unnamed |
| Sockets, uploads, crypto, cron | `lib/socket-server.ts`, `lib/tigris.ts`, cron routes | ⛔ **Not reviewed** — killed early |

**Reviewed by hand during the same pass**, and clean:

- `next.config.ts` sets `X-Frame-Options: DENY`, `X-Content-Type-Options`, and
  `Referrer-Policy`. No CSP and no HSTS — hardening, tracked below as LOW.
- The REST chat path moderates **before** responding
  (`app/api/mobile/events/[eventId]/chat/route.ts:460-534`), awaiting the
  classifier with a timeout and hiding flagged content in the same request.
  There is no socket emit on that path. The socket path itself is unreviewed.

**Next pass must start with authorization and IDOR across the 80 routes** — the
largest unexamined surface, and the one where the four findings below suggest
the same mistake is likely to recur.

---

## Open

### LOW — no Content-Security-Policy or HSTS

`next.config.ts:27`. Three good headers, and neither of the two that matter most
for a dashboard that renders user-supplied event and profile text.

Not a concrete vulnerability today — no XSS sink is known — which is exactly why
it is LOW rather than ignored: CSP is what makes an unknown future XSS
non-catastrophic. HSTS matters because `dashboard.blendn.app` handles session
cookies.

Do both when someone is next in that file.

---

## Closed

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
| Every `"use server"` file reads the session | `__tests__/server-action-authz.test.ts` |
| Trust bands, volume floors, harassment never averaged away | `__tests__/trust.test.ts` |

Aggregates have privacy floors so a number cannot name a person:
`MIN_ATTENDEES = 8` (`lib/connection-metrics.ts`), `MIN_RATINGS = 4`
(`lib/trust.ts`). **Neither floor has been tested for bypass via date-range or
filter narrowing** — that belongs in the next pass.

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
