# Dashboard data gaps

Every metric in the redesign was mapped to a real query before being built. This
records the ones that could **not** be produced honestly from the current schema,
what was shipped instead, and what it would take to close them.

Nothing here is a bug in the design. These are places where the design assumes a
data model the product does not have yet.

## 1. There is no `venues` table — the big one

The venue-owner role is built around venues, but a venue is not a thing the
schema models. `events.venue_name` is a nullable free-text `String`, and
"venue owner" is just a `user_role` whose events happen to carry venue names.

Everything venue-shaped is therefore derived by grouping events on that string.

**Shipped:** `buildVenueOverview` groups by `venue_name` and the UI states the
caveats on screen rather than hiding them.

**What breaks:**

| Designed | Reality |
|---|---|
| "Capacity 80" per venue | No venue capacity exists. Shows the largest `max_capacity` any event there declared, labelled "largest declared". |
| "No venues linked" + a linking flow | There is nothing to link. A venue exists only once an event names it. |
| One row per venue | "The Loft", "the loft" and "The Loft " are three venues. No normalisation, no ID. |
| Venue address, photos, amenities | Not modelled at all. |
| A venue owner who owns venues but hosts no events | Invisible — they have no events, so they have no venues. |

**To close it:** a `venues` table (id, owner_id, name, address, lat/lon,
capacity, amenities), `events.venue_id` as a real FK alongside or replacing
`venue_name`, and a backfill that maps existing free-text names onto rows. That
is a schema change plus a migration plus a venue CRUD surface — a feature, not a
dashboard fix.

## 2. "Active this week" is a refresh-token proxy, not sessions

There is no session or app-open event anywhere. The closest signal is
`mobile_refresh_tokens.created_at`, which fires when the mobile app exchanges a
token — roughly every 15 minutes of active use, but also on cold start and not
at all if the user only reads cached content.

**Shipped:** counted as distinct users with a refresh token issued in the last 7
days, labelled "session proxy" in the UI so nobody reports it as DAU.

**To close it:** an app-open/heartbeat event from the mobile client, or an
`last_active_at` column stamped on authenticated mobile requests.

## 3. Rating distributions are per-venue but ratings are per-event

`event_ratings` attaches to an event, not a venue. The per-venue rating
distribution sums the ratings of every event held there.

**Shipped as designed**, and the interpretation the design calls for — "a low
rating at one room across several organisers' events is a facilities signal" —
holds. But a single bad organiser running five events at one venue will drag
that venue's distribution, and the data cannot separate the two causes.

**To close it:** rate the venue separately from the event, or weight by distinct
organiser.

## 4. Moderation categories are free-shaped JSON

`moderation_flags.categories` is `Json` with no schema. OpenAI's moderation
endpoint writes `{hate: 0.92, sexual: 0.1}`; the keyword filter writes its own
shape.

**Shipped:** `topCategory()` takes the highest-scoring numeric key, falls back to
the first key, then to `source`. It will not crash on an unexpected shape, but a
producer that writes non-numeric scores gets a less useful label.

**To close it:** a `category` enum column on `moderation_flags`, written by every
producer.

## 5. User reports are a separate shape from pipeline flags

The design's moderation queue has a "User reports" tab alongside pending /
approved / rejected. But `message_reports`, `user_reports` and `event_reports`
are three separate tables with their own statuses and columns — they are not
rows of `moderation_flags`.

**Shipped:** the three flag states only. The tab is not faked with an empty list.

**To close it:** either a union view over the report tables, or route user
reports into `moderation_flags` at write time so the queue has one source.

## 6. No "drafts without a publish" activation signal for organisers

The organisers screen in the design shows a "never published" status derived
from draft count vs published count. That works today, but `events.status`
carries no timestamp for when it became a draft, so "has been sitting in draft
for three weeks" — the actually actionable version — is not available.

**To close it:** a `status_changed_at` column, or an event-status audit trail.

## Removed in this redesign

**CSV export.** The old overview had an `ExportMenu` producing three CSV
bundles. The redesign has no export affordance anywhere, so it was removed
rather than left orphaned against a report shape that no longer exists. If
exports are still wanted, they should be designed into the new IA — probably per
screen, against the table that screen already shows, rather than a page-level
bundle of everything.
