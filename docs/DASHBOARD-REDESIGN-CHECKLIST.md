# Dashboard redesign checklist

One row per screen. **Chain** means the gated chain in `TESTING-PLAYBOOK.md` §1
was run for the screen — operator questions and cuts, a direction with a
memorable detail, a mockup on disk, then built and driven with the row read
back. **Driven** means the screen was exercised end to end on the running app
(browse / Chrome DevTools, later Playwright) with its writes read back from
Postgres. Both columns cite the commit or PR that did it, so a tick can be
checked rather than trusted.

`E17` (SCRUM-42, 2026-08-27) was a density and responsive pass over thirteen
pages — prose cut, zero overflow at 375/768/1280 — and is **not** a redesign;
it appears here only as a note.

Order of work: the product owner's call on 2026-09-11 — the organiser's
authoring screens first, then the rest of the organiser surface, then venue
owner, then the admin remainder. Each screen goes through the chain, the six
gates, the specialists, and a drive, before the next one starts.

## Legend

- ✅ done, with the commit / PR
- ◐ partial — part of the screen went through the chain, the rest did not
- — not done

## Shared

| Screen | Chain | Driven | Notes |
|---|---|---|---|
| Nav, tokens, sidebar groups | ✅ 1482a7a, 7b512ac | ✅ every drive since | `lib/dashboard-nav.ts` groups; colours back on tokens |
| Site header (one `h1`) | ✅ f8a0ded, E17 | ✅ | `KNOWN_DOUBLE_H1` is empty |
| DataTable primitive | ◐ c1ff7fb (server search), 26fe6a4 | ✅ venues | not itself a screen |

## app_admin

| Route | Chain | Driven | Notes |
|---|---|---|---|
| `/dashboard` (admin overview) | ✅ 5c3e7f9 | ✅ Chrome DevTools 2026-09-10 | five panels, attention strip |
| `/dashboard/moderation` | — | ✅ E10 (API + dashboard data) | E17 prose cut only |
| `/dashboard/moderation/reports` | — | ✅ E10 | |
| `/dashboard/events` (list) | ✅ 46d00fb, 380ba27 | ✅ 2026-09-10 | server-fetched, zero column fixed |
| `/dashboard/events/curate` | ✅ #276-era W5 + design review 2026-08-24 (6→9/10) | ✅ browser, 2026-08-24 | form → `components/ui/form`, timezone bug |
| `/dashboard/events/new` | ◐ b63008e readiness strip only | ✅ 2026-09-10 (strip) | **the form body never went through the chain — next** |
| `/dashboard/events/[id]/edit` | ◐ same strip | ◐ | same form as `/new` |
| `/dashboard/events/[id]` (overview, live, attendees tabs) | ◐ #156 attendance panel + occupancy hero, #340 publish line | ✅ E8/E9 | tabs never designed as one screen |
| `/dashboard/events/[id]/messaging` | — | ✅ E10 | organiser room view |
| `/dashboard/events/[id]/feedback` | — | ✅ E12 | digest + disclosure floor |
| `/dashboard/chatrooms` | — | ✅ E10 | E17 fixed the 403-as-empty state |
| `/dashboard/users` | ✅ 380ba27, 99bf013, f2aa14e | ✅ 2026-09-11 local + read back | deleted-account state, status Select |
| `/dashboard/organisers`, `/organisers/[id]` | ✅ 503dead (index) / — (detail) | ✅ index | detail page not designed |
| `/dashboard/venues` (admin index), `/venues/[id]`, `/venues/new`, `/venues/[id]/claim` | ◐ c1ff7fb, 634bfae (index search + index) / — | ✅ index 2026-09-10 | detail/new/claim not designed |
| `/dashboard/venue-owners`, `/venue-owners/[id]` | ✅ 503dead (index) / — | ✅ index | |
| `/dashboard/leads` | — | ✅ E3 | E17 prose cut |
| `/dashboard/claims`, `/claims/venues`, `/claims/brands` | ✅ W5 + design review 2026-08-24 (events) / ◐ (venues, brands share the queue) | ✅ E7 | one queue, three kinds |
| `/dashboard/onboarding` (applications) | ✅ ac0962f, ce62887, 2fd92dd | ✅ 2026-09-11 | credential panel, evidence order |
| `/dashboard/sponsors` (brands) | — | ✅ E6 | |
| `/dashboard/creative-review` | — | ✅ E6 | |
| `/dashboard/charges` | — | ✅ E6 | |
| `/dashboard/organisations` | — | ✅ E7 | |
| `/dashboard/categories` | — | ✅ E3 | merge keeps interests (W14) |
| `/dashboard/amenities` | — | ✅ #298 | |
| `/dashboard/reports` | — | ✅ E12 (exports) | |
| `/dashboard/audit` | — | ✅ E3 | |
| `/dashboard/settings` | — | ✅ E3 | |

## organizer

| Route | Chain | Driven | Notes |
|---|---|---|---|
| `/dashboard` (organiser overview) | — | ✅ E4 | admin overview was redesigned; this branch of `getDashboardOverview` was not |
| `/dashboard/events` | ✅ shared with admin | ✅ | organiser scope = org membership |
| `/dashboard/events/new` | ◐ strip only | ✅ strip | **first in the queue** |
| `/dashboard/events/[id]/edit` | ◐ strip only | ◐ | with `/new` |
| `/dashboard/events/[id]` + tabs | ◐ | ✅ E4 | |
| `/dashboard/events/[id]/messaging` | — | ✅ | |
| `/dashboard/events/[id]/feedback` | — | ✅ | |
| `/dashboard/attendees` | — (W18 fixed the roster's PII) | ✅ E4 | pseudonymous roster |
| `/dashboard/chatrooms` | — | ✅ | |
| `/dashboard/organisation` (my organisation) | — | ✅ E4, #322 domain verification | members, domains, invites |
| `/dashboard/reports`, `/dashboard/audit`, `/dashboard/settings` | — | ✅ | shared |

## venue_owner

| Route | Chain | Driven | Notes |
|---|---|---|---|
| `/dashboard` (venue-owner overview) | — | ✅ E5 | H2 scope fix; not designed |
| `/dashboard/venues` (my venues), `/venues/[id]` | — (#156 occupancy hero on detail) | ✅ E5, #319 lifecycle | building occupancy |
| `/dashboard/venues/new`, `/venues/[id]/claim` | — | ✅ E7 | |
| `/dashboard/events`, `/events/[id]` | shared | ✅ | canOperate tabs |
| `/dashboard/chatrooms`, `/organisation`, `/reports`, `/audit`, `/settings` | — | ✅ | shared |

## sponsor

| Route | Chain | Driven | Notes |
|---|---|---|---|
| `/dashboard` (sponsor overview) | ✅ #299 + sponsor-surfaces mockup 2026-08-16 | ✅ E6 | |
| `/dashboard/brand` | ✅ same | ✅ E6 | |
| `/dashboard/placements` | ✅ same | ✅ E6 | reach suppressed |
| `/dashboard/organisation`, `/settings` | — | ✅ | shared |

## The queue, in order

1. `/dashboard/events/new` and `/events/[id]/edit` — the form body (organiser)
2. `/dashboard` for organiser and venue owner — the two overview branches
3. `/dashboard/events/[id]` — overview, live, attendees, messaging, feedback as one screen family
4. `/dashboard/attendees`, `/dashboard/chatrooms`, `/dashboard/organisation`
5. `/dashboard/venues/[id]`, `/venues/new`, `/venues/[id]/claim` (venue owner)
6. Admin remainder: moderation (+reports), sponsors / creative-review / charges, organisations, organisers/[id], venue-owners/[id], leads, categories, amenities, reports, audit, settings
