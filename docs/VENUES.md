# Venues

A venue is a building. An event is something that happens in one.

That distinction is the whole feature. Before v0.31.0 the platform had no way to
express it: `events.venue_name` was free text, and the `venues` table existed
with a detail page, a search index and a permission resolver reading it —
**and nothing had ever written a row to it**. `/dashboard/venues/[id]` 404'd for
every id.

---

## Why a venue is an access-control object, not a directory entry

Owning a venue record grants **operational control over other people's events**.

An organiser who picks a claimed venue links their event to it. The venue's
owner then sees that event's chatroom, its attendee count and its feedback —
for an event they are not running. That is deliberate and useful (a venue
manager should know what is happening in their building tonight), and it is also
why a venue cannot be a form anyone can fill in.

So a false claim is an **access-control failure**, not a data-quality one, and
the safeguards are sized accordingly.

### The four layers

They fire in this order, and each one exists because the next is not enough on
its own.

| # | Layer | Where | What it stops |
|---|---|---|---|
| 1 | Proximity dedup | `venuesNear`, 100 m | A second record for a building that already exists |
| 2 | Admin review | `venue_claims` queue | Ownership asserted by anyone who can fill in a form |
| 3 | One owner per venue | `assignVenueOwner`, approval transaction | A silent second owner; a second claim is a *dispute* |
| 4 | Reversible auto-link | organiser can unlink, audited | An approved claim capturing events it should not |

**Layer 4 is why 1–3 do not have to be bulletproof.** Nothing here can be
verified automatically — a GSTIN checksum proves the format, not the ownership,
and a trade licence is a PDF. The system is designed so a wrong decision is
recoverable rather than so no wrong decision is possible.

---

## Creating a venue

`/dashboard/venues/new` — staged: **Basics → Location → Capacity → Review**.

Who may create:

| Role | Result |
|---|---|
| `venue_owner` | Venue is **owned by their organisation from creation** |
| `app_admin` | Venue is created **unclaimed** |
| `organizer` | Refused |

A venue owner describing their own place does not create-then-claim it; that
would be ceremony with no safety value. An organiser is refused outright because
a venue grants control over other people's events and an organiser has no claim
to that — they still get free-text venue names, which is what most events need.

### The Location stage is the one that matters

`venuesNear(lat, lng)` runs on every pin move, debounced. A hit within 100 m
**blocks progression** until the answer is claim-or-confirm — not a warning that
can be scrolled past.

The check runs client-side as an optimisation and again server-side as the gate.
`createVenue` refuses without `acknowledgedDuplicates`, so a caller bypassing the
UI hits the same wall.

The acknowledgement is keyed on the pin (`"${lat},${lng}"`) rather than held as
a boolean, so moving the map invalidates it with no reset racing the next
lookup.

### Venue type seeds the check-in extent

`lib/venue-types.ts` — 35 types in 8 groups. The type is not decoration: it sets
the default check-in extent, from ~150 m for a stadium to ~20 m for a café.

One shared default for a café and a stadium is how a real football match on
production ended up carrying a **100 km** check-in radius. An organiser given
one wrong default drags the handle until it "looks safe".

OSM tags suggest the type when a building footprint is imported
(`venueTypeFromOsm`), so the common case needs no decision at all.

---

## Claiming a venue

`/dashboard/venues/[id]/claim`. Venue owners and admins only.

**Trade licence is the only required document.** It is the one that names the
address. FSSAI and liquor licences vary by venue type — a park has no FSSAI
licence, and requiring one would block honest claims.

GSTIN is optional and **checksum-validated only**. `lib/gstin.ts` says so in the
message it returns, because a claimant who thinks the GSTIN check is an
ownership check will not bother attaching a good licence.

Re-filing after a decline **upserts** on `(venue_id, org_id)` rather than
stacking rows, and clears the previous decision — otherwise a reviewer wades
through duplicates and a re-file inherits its own rejection.

### Disputes

A claim against a venue that already has an owner is filed as a dispute rather
than refused. Refusing would leave a genuine owner with no route at all when the
wrong organisation claimed first.

The queue shows the incumbent's **hosting history** as evidence. Six events at a
venue is a strong signal, and a reviewer comparing two document sets should not
have to open another screen to see it.

### The approval transaction

Approving does three things atomically:

1. sets `venues.owner_org_id` and `claimed_at`
2. marks the claim `approved`
3. **declines every other pending claim on that venue**

Step 3 matters: leaving them pending shows a reviewer a queue of requests for a
venue that now has an owner.

Declining requires a reason of at least 10 characters. A decline that reaches
the claimant with no reason produces an identical re-file, and the queue gets
the same row again.

---

## Events and venues

### The redundancy

The event form asked for venue name, address, city, latitude, longitude and
capacity — **six of the ten venue-shaped fields** — about a building that does
not move.

Picking a listed venue now fills them.

### Verify once, don't hide

| Field | On picking a venue |
|---|---|
| Name, address, city, lat/lng | Filled, still editable |
| Capacity | Prefilled **only when empty**; warns when exceeded, never blocks |
| Geofence | Inherited, and **re-validated** on the way in |

Everything stays editable because an event on the rooftop of a three-floor venue
legitimately differs from the venue's own footprint — that is the sub-venue
geofence case, not an error.

Capacity prefills only when empty because overwriting a number the organiser
already typed would silently change what they meant. It warns rather than
blocks because venue capacity is the room's maximum and an event's is what
*this* event wants, legitimately lower for a seated layout.

The inherited geofence is re-validated rather than trusted. It came from the
database, but so did the 100 km radius.

### Free text stays first-class

Most events are at places not on the platform. The picker is a text input that
happens to suggest — not a select. Unlinking keeps the name, location and
geofence, because the organiser typed an event at this place and clearing it all
would punish them for unlinking.

### `venue_link_status` is derived, never sent

```
auto_linked  → organiser picked the venue; nobody has confirmed it
confirmed    → the venue owner agrees this event is theirs to see
disputed     → the venue owner says it is not
```

**The status is resolved server-side in `lib/venue-link.ts` and the request's
value is ignored.** A client that could send `confirmed` would link its event to
someone else's venue and mark it settled in one call, skipping the dispute path
and picking up the chatroom and attendee count that come with a link.

`lib/venue-link.ts` is deliberately **not** in `lib/venue-actions.ts`: that file
is `"use server"`, so everything it exports becomes an endpoint any signed-in
caller can invoke. This should not be one.

Three behaviours the tests pin down:

- a `PATCH` **omitting** `venue_id` leaves the link alone — a title edit must not
  unlink a venue
- an id matching no venue is **dropped**, and the save proceeds — failing the
  whole update over a stale link would cost the organiser their edit for
  something they can neither see nor fix
- an existing `confirmed`/`disputed` status **survives a re-save**, but is not
  carried across a change of venue — a confirmation applies to the venue it was
  made about

---

## Reversing a link — layer 4, finally implemented

`lib/venue-link-actions.ts`. The two directions are deliberately asymmetric.

| Who | Action | Effect |
|---|---|---|
| Venue owner | **Dispute** | Flags the link `disputed`, with a reason. Does **not** detach. |
| Venue owner | **Confirm** | Sets `confirmed` — the only place that value can ever be written |
| Organiser | **Unlink** | Detaches immediately. No review. |

An owner who could unlink freely could hide events they would rather not answer
for, so disputing flags rather than detaches and an admin resolves it.

An organiser detaches outright, because nobody should have to wait on a review
to stop a stranger seeing their attendee list.

Unlinking **keeps `venue_name` as free text**: the event really was held there,
and clearing it would punish an organiser for correcting a bad link.

Authorization resolves on **org membership**, not role — the same rule as
`eventPermissions`. The organisation that owns the venue speaks for it, whoever
in that organisation clicks. A test asserting role-based denial was wrong about
this and was corrected rather than the code.

---

## Files

| File | What lives there |
|---|---|
| `lib/venue-types.ts` | The 35-type vocabulary, labels, default extents, OSM mapping |
| `lib/venue-actions.ts` | `venuesNear`, `createVenue`, `updateVenue`, `assignVenueOwner`, `searchVenues`, `venueById` — all `"use server"` |
| `lib/venue-claim-actions.ts` | `fileVenueClaim`, `getVenueClaimQueue`, `decideVenueClaim` |
| `lib/venue-link.ts` | `resolveVenueLink` — route-internal, deliberately not a server action |
| `lib/geofence.ts` | Extent / buffer / accuracy, and the check-in rule |
| `components/venue-create-form.tsx` | The staged create flow |
| `components/venue-claim-form.tsx` | Filing a claim or a dispute |
| `components/venue-claim-queue.tsx` | Admin review |
| `components/venue-type-picker.tsx` | Grouped, searchable type picker |
| `components/event-form/venue-picker.tsx` | The picker in the event form |
| `components/geofence-editor.tsx` | Circle/polygon editing, OSM footprint import |

Tests: `__tests__/venue-types.test.ts`, `venue-actions.test.ts`,
`venue-claims.test.ts`, `venue-link.test.ts`, `geofence.test.ts`.

---

## Known gaps

- ~~Venue owner's dispute UI~~ — **built in v0.37.0**, `lib/venue-link-actions.ts`
  and the "Events at your venues" section of `/dashboard/venues`.
- ~~`/dashboard/venues` groups by `events.venue_name`~~ — **fixed in v0.38.1.**
  Grouped by `venue_id` where an event has one, and by a normalised name where
  it does not. Pure id-only grouping was rejected: an organisation whose events
  predate the link would see its venues vanish rather than merge.
- **No PostGIS.** All geometry is pure JS over one event's fence at a time. The
  seam is "events near me", which would want a spatial index.
- ~~Five production events carry oversized check-in radii~~ — **fixed in
  v0.35.0**. `scripts/clamp-oversized-radii.ts` replaced the five pre-cap radii
  (100 km, 10 km ×2, 5 km ×2) with real geofences. All five were past events, so
  no live check-in was affected.
