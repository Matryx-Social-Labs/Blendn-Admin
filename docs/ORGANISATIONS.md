# Organisations, onboarding, and access

How a host gets onto Blend'n, proves it is who it says, and lets colleagues in.

## The model

A host is a **company, not a login**. Before v0.18.0 `events.organizer_id` and
`venues.owner_id` pointed at a `User`, which meant Byg Brewski *was* one
person's account: their colleagues could not help, and if that person left the
venue was orphaned.

Everything is now an `organisations` row, including a sole trader — `kind`
distinguishes them, so an individual organiser exists with one member and no
GSTIN while a venue owner must be a company. A uniform shape beats a
user-or-org union at every call site.

```
organisations
├── organisation_members          who may act for it (owner / admin / staff)
├── organisation_domains          domains it has proved it controls
├── organisation_invites          outstanding invitations
└── organisation_join_requests    people asking to be let in
```

`events.organizer_id` is still written. It answers "who created this", which is
a different question from "who is accountable", and stays useful for audit and
for a member's own event list.

## Two permission resolvers, deliberately apart

| Resolver | File | Question |
|---|---|---|
| `eventPermissions(actor, event)` | `lib/rbac.ts` | May this person operate this event? |
| `orgPermissions(role)` | `lib/org-permissions.ts` | May this person change who is in this company? |

They were merged once, and the result was `canManageEvent` and
`canModerateChat` contradicting each other with a venue owner locked out of
every chatroom. Keep them apart.

**Event access** resolves on organisation membership:

| actor | condition | edit | operate |
|---|---|---|---|
| `app_admin` | always | ✅ | ✅ |
| host | member of the organising org | ✅ | ✅ |
| venue owner | member of the venue's owning org | ✗ | ✅ |

**Org management** resolves on the member's `org_role`:

| | manage members | edit org | verify domain | delete org |
|---|---|---|---|---|
| owner | ✅ | ✅ | ✅ | ✅ |
| admin | ✅ | ✅ | ✗ | ✗ |
| staff | ✗ | ✗ | ✗ | ✗ |

Running events is deliberately absent from the second table: *every* member can
operate events, which is what "staff run events" means.

`canVerifyDomain` is owner-only because verifying a domain is what unlocks
restricting invites to it — whoever controls the domain controls who can be
invited without an override.

## Onboarding

```
/apply  →  confirm email  →  admin review  →  approved
```

Submitting creates **no account**. It creates an
`organiser_onboarding_requests` row; approval is what creates the organisation,
the `User`, and the membership joining them, in one transaction. A user with no
org is locked out of every screen, and an org with no members is unreachable,
so it is all three or none.

### The anti-spam gate

Three things guard the public form, in increasing order of how much they help:

1. **IP rate limit** — 3/hour. Stops the trivial script.
2. **Tier gate** — a company-domain email advances as-is; a free-provider
   address (gmail, yahoo, outlook, rediffmail, proton…) must also carry a
   GSTIN **or** a website before it can be submitted.
3. **A human reads every one.**

(3) is the real defence. (1) and (2) exist so a human is not reading four
thousand rows.

The tier decides what must be *supplied*, never whether a human looks.

### GSTIN

Validated by **checksum only** — 15 characters, state code + PAN + entity + `Z`
+ check digit (`lib/gstin.ts`). There is no free official verification API; the
GST portal requires GSP accreditation, and confirming a GSTIN belongs to a
named business means a paid provider.

The review queue shows the checksum result and says *"Not verified as
registered."* Provider lookup is a seam, not a dependency.

### Approving

Creates the org (status `verified`), the user, and an `owner` membership. If
the applicant already has an *attendee* account, it is promoted rather than
duplicated — and their **password is not reset**, since overwriting it would
lock them out of the mobile app mid-session.

A verified company-domain email is pre-claimed as an
`organisation_domains` row, so nobody proves the same thing twice — unless
another org already holds that domain, in which case it is skipped.

## Domain verification

DNS TXT on the apex:

```
Type   TXT
Host   @
Value  blendn-verify=<token>
```

The email fallback exists for venues who cannot edit their own DNS: a token
sent to `admin@` / `postmaster@` / `webmaster@` / `hostmaster@` at that domain.
Weaker, but those addresses are not self-serve either. It will **only** ever
target a role address — sending to an address the claimant types in would
verify nothing at all.

`@@unique([domain])` on `organisation_domains` is load-bearing. Without it two
organisations could each verify `bygbrewski.com`, and each would then
auto-accept the other's staff.

Verification unlocks *restricting* invites. An org without a verified domain
can still invite; it just cannot restrict.

## Invites

**You cannot stop an org admin inviting whoever they like.** That is their
company's call, exactly as it is in Slack or Notion, and a design that pretends
otherwise is theatre. What is actually enforced:

- invites **restricted to the verified domain by default**
- an out-of-domain invite requires a typed reason, which lands in `audit_logs`
- an invited person joins at **the invited role**, never higher
- an owner invite can only be sent by an owner
- every invite, acceptance and role change is attributable

The token is the sensitive surface — it grants access to a company's dashboard:

| Property | Why |
|---|---|
| stored as SHA-256 | a database dump yields hashes, not usable invitations |
| bound to the invited address | a forwarded link is not a way in |
| single-use | claimed with `updateMany … accepted_at: null`, so two concurrent clicks make one membership |
| 7-day expiry | a link living forever in an inbox is a way in for whoever inherits it |

Accepting requires being **signed in**. An invite is permission to join a
company, not a way to mint a login.

## Request to join

Someone with an address on a verified domain can ask for access. **The org's
own admin approves**, not the platform, and always at `staff`.

Auto-join was rejected: a verified domain proves the company owns the domain,
not that every address on it should reach the dashboard. Granting more than
`staff` from a request would make domain verification an escalation path.

## Guard rails worth knowing

- The **last owner** cannot be demoted or removed. Losing them leaves an org
  nobody can administer, including the person who did it.
- An **admin cannot promote to owner** or change an owner's role — otherwise
  the admin tier is the owner tier with an extra click.
- `app_admin` is **not** silently granted org management. Platform admins use
  `/dashboard/organisations`; an admin acting on the host screen would be
  recorded as though the org's own owner did it.
- Suspending an org is reversible and **does not cascade**. Deleting a host
  would take every event, check-in and message belonging to the attendees who
  went.

## Screens

| Route | Who | What |
|---|---|---|
| `/apply` | public | the application form |
| `/apply/verify` | applicant | confirms the email token |
| `/invite` | invitee | accepts an invitation |
| `/dashboard/onboarding` | platform admin | the review queue |
| `/dashboard/organisations` | platform admin | every org, suspend/reinstate |
| `/dashboard/organisation` | host | members, invites, domains, join requests |

## Email

`lib/email.ts` — Resend's REST API over `fetch`, no SDK.

**Unconfigured is a first-class state.** Without `RESEND_API_KEY` and
`EMAIL_FROM` every flow still completes; the caller gets
`{ sent: false, reason: "not_configured" }` and the dashboard shows the link or
the generated password to pass on by hand. What must never happen is a silent
swallow — an invite reporting success while nothing was sent leaves someone
waiting for a mail that is not coming.

## Tests

| File | Covers |
|---|---|
| `__tests__/org-permissions.test.ts` | the org-role matrix |
| `__tests__/event-permissions.test.ts` | the event matrix, every row |
| `__tests__/org-invites.test.ts` | token single-use, recipient binding, domain policy, tier gate |
| `__tests__/domain-verify.test.ts` | TXT matching, chunked records, role addresses |
| `__tests__/gstin.test.ts` | checksum |
| `__tests__/integration/event-permissions.itest.ts` | the real query shape against real rows |

The invite rules are asserted before they are written, because the two worst
failures here — a token that still works after use, and a token that works for
whoever holds it — both look like success in manual testing.
