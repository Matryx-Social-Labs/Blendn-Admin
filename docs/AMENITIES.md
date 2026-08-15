# Amenities and place — what an event offers, and where it is

The Scene's frame (`1141:4853`) draws two amenity tiles and a neighbourhood line.
Neither was collected. This is the plan for collecting both, and the reasoning
behind each call, so the next person does not have to re-derive it.

Reviewed with `/plan-eng-review`; the decision log is at the bottom.

## What already exists

Most of this is not new work. Listed first so nobody rebuilds it.

| Already there | Where | Used how |
|---|---|---|
| Nominatim proxy, both directions | `app/api/geocode/route.ts` | Forward search for the picker, **reverse** for derivation |
| `addressdetails=1` on both branches | same, `:53`/`:55` | The neighbourhood is already in the response we fetch |
| Address → city extraction | `lib/address.ts` | `neighbourhoodFrom()` joins it, deliberately separate from the city chain |
| Map picker setting lat/lng | `venue-create-form.tsx:128`, `location-section.tsx:61` | Unchanged — a human still disambiguates |
| Curated vocabulary pattern | `categories` model + `scripts/seed-categories.ts` | `amenities` copies its shape |
| Org-scoped permission resolver | `lib/rbac.ts` `eventPermissions` | `venuePermissions` mirrors it |
| Venue ownership | `venues.owner_org_id`, `venue_claim_status` | Gates whether suggestions exist |
| Integration test harness | `__tests__/integration/*.itest.ts`, CI `postgres:16` | The DB-level rules are testable |

Nothing here is rebuilt. The only genuinely new surfaces are the vocabulary
table, two join tables, `venuePermissions`, and one derived column.

## Amenities

### The shape

```
  amenities                     (vocabulary — seeded, is_active)
      ▲                    ▲
      │ Restrict           │ Restrict
      │                    │
 venue_amenities      event_amenities
      │ Cascade            │ Cascade
      ▼                    ▼
   venues                events
  (owner curates)     (organiser asserts)
```

`Cascade` points at the thing that owns the row; `Restrict` points at the
vocabulary. Deleting a venue takes its amenity links with it. Deleting an
*amenity* is refused while anything references it — retirement is
`is_active = false`, which hides it from both pickers and leaves every past
event saying what it actually offered.

### Suggestion, not inheritance

```
organiser picks a venue
        │
        ▼
  venue.owner_org_id set?  ──no──▶  no suggestions; organiser ticks from vocabulary
        │yes
        ▼
 show the venue's amenities as DEFAULTS, pre-ticked
        │
        ▼
 organiser edits and saves  ──▶  event_amenities = what the ORGANISER asserted
```

The event stores its own rows. It never reads through to the venue at render
time. So a venue editing its list next month cannot change what last month's
event claimed, and an organiser who unticks "Open Bar" is believed.

**Ownership gates suggestions, not link confirmation.** The organiser's picker
always writes `venue_link_status: "auto_linked"` (`location-section.tsx:67`);
`confirmed` is produced later by the venue owner clicking "That's mine"
(`linked-events.tsx:153`). Gating on `confirmed` would show an empty list at the
only moment the organiser uses it. Ownership is the signal that a human curated
the list; confirmation is a different question about a different fact.

### Authorisation

`venuePermissions(actor, venue)` in `lib/rbac.ts`, mirroring `eventPermissions`:
`app_admin` always; `venue_owner` when a member of `venue.owner_org_id`;
everyone else denied. `createVenue` is role-gated only, which is right for
creation (a new venue has no owner) and wrong for editing — copying it would let
any venue owner edit any building.

## Place

### The precedence chain

Nominatim does not return one field. It returns whichever of several it has, at
inconsistent granularity, in the local language.

```
neighbourhood → suburb → quarter → city_district → (null)
                                                     │
                                          organiser override wins over all
                                                     │
                                        render: override ?? derived ?? city
```

**This is a default, not a fact.** `lib/address.ts:23-26` already documents that
these fields were burned once: a pin in Whitefield returns `suburb: "Whitefield"`
*and* `city: "Bengaluru"`, and grouping on them split one city into a dozen. They
are excluded from the city chain and must stay excluded — `neighbourhoodFrom()`
lives beside `cityFrom()` and shares nothing with it.

Rendering a messy value is survivable where grouping on it was not. But
"Koramangala 5th Block" is not "Arts District", so the organiser can overwrite
it. Machine suggests, human asserts — the same rule as amenities.

### Derived server-side, from a human-confirmed point

The client keeps the picker: five results, a person chooses. That coordinate then
feeds `check_in_radius` and GPS check-in, which the product thesis calls
load-bearing — a silently wrong pin fails people at the door with nothing in the
app to explain it. So a human disambiguates, and the **server** reverse-geocodes
the confirmed lat/lng. Derived fields are never taken from the client.

Best effort: short timeout, failure swallowed, `null` stored, event saved.
Nominatim is a free service with a usage policy; a decorative subtitle must never
fail event creation. A backfill fills the nulls later.

### `GEOCODE_COUNTRIES`

`app/api/geocode/route.ts:53` hardcodes `countrycodes=in`, so address *search*
is India-only while *reverse* is global. `scripts/seed-qa.ts` seeds Saarbrücken
to exercise multi-country, and cannot reach it through the UI. Becomes an env
var read through `lib/env.ts`, default `in`, so staging sets `in,de` and matches
its own seed.

## Failure modes

| Path | Fails how | Test | Handled | User sees |
|---|---|---|---|---|
| Reverse-geocode on write | Nominatim 502 / timeout | itest asserts 201 with null | yes — swallowed | city, as today |
| Backfill job | Never scheduled; nulls persist | unit on the query | **partial** | a missing subtitle |
| Amenity retired | `Restrict` blocks delete | itest | yes | picker hides it; past events keep it |
| Venue amenity write | Non-owner attempts | itest 403 | yes, via `venuePermissions` | "not yours" |
| Suggestions | Venue unowned | unit → `[]` | yes | own list, no suggestions |
| Neighbourhood | Local-language / odd granularity | fixtures per city | yes — override | whatever they typed |

**Critical gap:** the backfill has no schedule, no retry and no monitoring in this
plan. It is the one path with a real failure that is currently silent. The repo
already runs a self-scheduling sweeper, so the pattern exists — but "add a
backfill job" is not yet a plan, and it should not ship as one.

## NOT in scope

- **App-level access enforcement.** `door_policy` stays informational; nothing
  gates an RSVP. An approval queue or invite list is a separate feature.
- **Amenity filtering on the Pulse.** No filter UI, no index for it. Revisit when
  someone asks to browse by amenity.
- **Amenities on the event list payload.** Detail endpoint only — the cards draw
  none of it, and the list is the hottest endpoint in the product.
- **Amenity vocabulary admin UI.** Seeded via script, like `categories`. Adding
  one is a seed change until an admin asks otherwise.
- **Venue ownership lifecycle.** Transfers, disputes and null-owner venues keep
  today's behaviour; `venuePermissions` reads the current owner and nothing more.
- **Geocoder migration.** Nominatim stays. Rate limits, attribution and a paid
  provider are a separate decision.

## Parallelisation

| Step | Modules | Depends on |
|---|---|---|
| S1 Vocabulary + join tables + migration | `prisma/`, `scripts/` | — |
| S2 `venuePermissions` | `lib/rbac.ts` | — |
| S3 `neighbourhoodFrom` + `GEOCODE_COUNTRIES` | `lib/address.ts`, `lib/env.ts`, `app/api/geocode/` | — |
| S4 Venue amenities UI + write | `components/`, `lib/venue-actions.ts` | S1, S2 |
| S5 Event amenities UI + write | `components/event-form/`, `app/api/events/` | S1 |
| S6 Reverse-geocode on write + backfill | `app/api/events/`, `lib/` | S3 |
| S7 Payload + app rendering | `lib/services/`, app repo | S1, S5 |

```
Lane A: S1 ─────────▶ S4 ──┐
Lane B: S2 ────────────────┤
Lane C: S3 ─────────▶ S6   ├──▶ S7
        S1 ─────────▶ S5 ──┘
```

Launch **A, B, C in parallel**. S4 waits on both A and B. S5 waits on A. S7 last.

**Conflict flag:** S4 and S5 both touch `components/`, and S5 and S6 both touch
`app/api/events/`. Keep S5 and S6 in one lane or land S5 first.

## Decisions

| | Decision | Why |
|---|---|---|
| D3 | Suggestions from owned venues | An unowned venue's list has no author |
| D4 | Table + join tables, not enum array | Mirrors `categories`; vocabulary edits without a deploy |
| D5 | Human picks the point, server derives | A wrong pin breaks GPS check-in |
| D6 | `GEOCODE_COUNTRIES`, default `in` | Market choice, not a constant at line 53 |
| D7 | `venuePermissions` in `lib/rbac.ts` | Role-only would be cross-tenant |
| D8 | Gate on ownership, not confirmation | The picker only ever produces `auto_linked` |
| D9 | `Restrict` + `is_active` | Retiring an amenity must not rewrite history |
| D10 | Best-effort geocode + backfill | A subtitle must not fail event creation |
| D11 | Detail endpoint only | The cards render no amenity |
| D12 | Precedence chain + organiser override | Derived is a default; the human wins |

**Open:** whether the venue layer should ship at all before venue ownership is
dense enough to populate suggestions. Raised by the outside voice, not resolved.
Full scope was chosen deliberately; this is the risk that choice carries.
