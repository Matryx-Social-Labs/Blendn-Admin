# Leads

Demo requests from `organizers.blendn.app`.

Implements `docs/LEADS_API_CONTRACT.md` from the landing-page repo, with three
departures documented below — each because the spec as written could not do what
it said.

**Leads are not applications.** A demo request is someone asking for a
walkthrough; applying for an account happens at `/apply` and has its own tier
gate and review queue (`organiser_onboarding_requests`). The tables stay
separate and cross-reference by email. Merging them would put an unvetted
marketing contact into a queue that grants platform access.

---

## The one rule

**Never return 2xx for a lead that was not stored.**

The implementation this replaces returned `{success: true}` while its database
was unconfigured. Every lead in that window was lost and every visitor was told
they were in. If the write fails, the endpoint returns 5xx and the landing page
shows an error.

Two consequences in the code:

- The notification fires **after** the write, and is not awaited into the
  response. An SMTP outage must not turn a stored lead into a 5xx.
- `LANDING_INGEST_TOKEN` unset logs at **error** level and warns at boot. An
  unset secret means every lead 401s and the public form fails silently
  forever — the same class of invisible outage.

---

## Why the browser never calls this

```
 organizers.blendn.app                    Railway
 ┌────────────────────────┐              ┌──────────────────────────┐
 │  demo request form     │              │  POST /api/leads         │
 │          │             │  server-to-  │        │                 │
 │          v             │─── server ──▶│        v                 │
 │  Vercel function       │   Bearer     │   validate + persist     │
 └────────────────────────┘              └──────────────────────────┘
```

No CORS handling here, deliberately. `middleware.ts` applies CORS only to
`/api/mobile/*`, and adding any for the landing origin would invite someone to
move the call into the browser later — where the token would end up in a bundle.

---

## The three departures from the contract

### 1. Rate limits key on the body, not the request IP

The contract's §6 asks for "5 per hour per IP". `lib/rate-limit.ts` keys on
`x-forwarded-for`, which for a **server-to-server** call is Vercel's egress
address on every single lead. Wired that way, the limit would cap the whole
world at five leads an hour and 429 the sixth real visitor.

The visitor's IP arrives in `body.ip`, so rate limiting runs *after* body parse
rather than as a pre-handler guard — the opposite of every other route here.

### 2. The per-email cap keys on the plus-stripped root

§6 says a per-email cap "catches `sam+1@`, `sam+2@`". Keyed on the raw address
it provably cannot: those are different strings. `emailRoot()` strips the tag so
the rule means something.

The stripped form is **never used to contact anyone** — `sam+blendn@` is a real,
deliverable address and mail to the stripped form may go somewhere else. Storage
and display always use the address as given.

### 3. Idempotency is scoped to open leads, via a nullable unique column

§4 specifies `UNIQUE (type, lower(email))`, permanently. That means a person who
requests a demo in August and again in February is shown success, stored
nowhere, and **never notified** — the same silent-drop class the endpoint exists
to prevent, just slower.

The natural expression is a partial unique index:

```sql
CREATE UNIQUE INDEX ... WHERE status IN ('new','contacted','qualified')
```

**Prisma cannot declare one.** It would live only in migration SQL, and this
repo applies schema two different ways:

| Where | How | Sees migration-only SQL? |
|---|---|---|
| CI (`.github/workflows/ci.yml:110`) | `prisma db push` | **No** |
| Production (Railway) | `prisma migrate deploy` | Yes |

So a partial index would exist in production and be missing in CI, and the
duplicate test would pass in prod and fail in CI for a real reason.

Instead: **`leads.open_key`**, a nullable unique column holding
`"<type>:<email>"` while the lead is open and `NULL` once it closes. Postgres
permits unlimited `NULL`s in a unique index, so the semantics are identical, and
both paths build it identically.

The tradeoff is that the column is application-managed and could drift. One
rule, `openKeyFor(status, type, email)`, is shared by every write path. A
Postgres generated column could not drift at all — revisit if `leads` ever grows
a second write path.

*(An early version of the integration test set `status` alone and failed. That
was the test being wrong, and it is the failure mode to watch for.)*

---

## Status workflow

```
  new ──▶ contacted ──▶ qualified ──▶ converted
   │           │             │             │
   └───────────┴─────────────┴─────────────┴──▶ archived
   │
   └──▶ spam
                     archived / spam ──▶ contacted   (recoverable)
```

Transitions are enforced in `lib/lead-actions.ts`, not just in the UI.
`contacted_at` is stamped **once**, on the first move out of `new` — re-stamping
would destroy the response-time measurement the screen exists to surface.

Reopening a closed lead restores `open_key` and can therefore collide, if the
person wrote in again meanwhile. That is reported rather than swallowed.

---

## The inbox

`/dashboard/leads`, admin only. A lead carries a stranger's name, email, IP and
user agent; organisers have no business in it.

- **Defaults to `new`.** An unfiltered list of every lead ever received is
  history. The inbox should show work.
- **Filters live in the URL**, so a filtered view is shareable.
- **Time-waiting is a column**, amber past 24 h and red past 48 h. A lead
  sitting untouched for four days is the actual failure mode, and it is
  invisible unless it is on screen.
- **"Already applied?"** is in the drawer *and* in the notification email —
  knowing the person signed up last week changes who picks it up and what they
  say first.
- **Notes are append-only.** "Called, no answer" and "called again, keen" are
  both worth keeping.
- **CSV respects the active filter.** An export that quietly returned everything
  while the screen showed twelve rows would be worse than no export.

Metrics strip: new this week, median time to contact, conversion (spam excluded
from the denominator — counting bots against the team measures the bots), and
oldest untouched. If the last two are ugly, the screen is doing its job.

---

## Notifications

**Two channels, both optional, both free.** Which is right depends only on
where the team actually looks, so the code does not decide.

| Env var | Channel |
|---|---|
| `LEADS_SLACK_WEBHOOK_URL` | Slack incoming webhook (Discord's Slack-compatible endpoint works too) |
| `LEADS_NOTIFY_EMAIL` | An address or alias, via Resend |

Set either, both, or neither. Nothing set means an info log naming both
variables — never a throw.

### Cost

Neither needs a paid plan. Slack incoming webhooks are available on the free
tier; Resend's free tier is far above demo-request volume.

Two things to check before choosing Slack, because they are Slack's terms and
they change: the free tier historically **caps a workspace at 10 app
integrations** and keeps **90 days of history**. If the workspace is near that
app limit this competes with something else, and a lead older than 90 days
stops being findable in Slack — though it is still in the inbox, which is the
real record.

### The webhook URL is a secret

Anyone holding it can post to that channel. It lives in Railway env vars, is
validated as a URL in `lib/env.ts`, and is never logged.

### Failure isolation

Both channels are attempted with `Promise.allSettled`, so a Slack outage does
not also cost you the email. Neither can reject: the caller does
`void notifyNewLead(...)` **after** the write, and a rejection there would be an
unhandled rejection — which on Node 15+ takes the process down. Tested.

The Slack message carries a plain-text fallback alongside its Block Kit blocks,
because a phone notification reading "[no preview]" defeats the point of sending
it immediately. It deep-links to `?lead=<id>`, which opens the drawer directly.

---

## Retention

`ip` and `user_agent` are personal data with no operational value once the lead
is worked — they exist to spot an abuse wave, and a year-old abuse wave is
history.

`scripts/purge-lead-pii.ts` clears both after `LEAD_PII_RETENTION_DAYS` (365).
Dry-runs by default; `--apply` writes. The lead itself is kept: status, email
and notes are the record of a business conversation.

**Not yet scheduled.** Run it manually or wire it to the existing cron.

---

## Environment

| Var | Required | What |
|---|---|---|
| `LANDING_INGEST_TOKEN` | for ingest | Comma-separated for rotation; 32+ chars |
| `LEADS_NOTIFY_EMAIL` | no | Where a new demo request is announced |

Rotation is two deploys: add the new token to the list, update Vercel, drop the
old one. Both work in between, or the window is an outage.

---

## Tests

| File | Covers |
|---|---|
| `__tests__/leads.test.ts` | Token comparison, rotation, plus-stripping, IP sanitising, validation |
| `__tests__/integration/leads-ingest.itest.ts` | The contract's acceptance checklist, against real Postgres |

The integration file is the **first test in this repo to invoke an API route
handler**. Every other DB-touching test mocks `@/lib/db`, which is why it could
not tell a working route from one that throws.
