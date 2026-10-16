# Seeding venues from open data

Places people go to meet, in Bengaluru, Mumbai, Delhi NCR, Hyderabad and Pune, from
Overture Maps. Every venue is live from day one (owner ruling, 2026-10-01): seeded
unclaimed, claimed later by its owner at `/claim/venue/<id>`.

## Sources, and the ones we do not use

| Source | Used for | Licence and what it asks |
|---|---|---|
| [Overture Maps places](https://docs.overturemaps.org/guides/places/) | Name, point, address, category, brand, website | CDLA-Permissive-2.0 or Apache-2.0 by provider; no OSM data, no share-alike. Each provider's line from [the attribution page](https://docs.overturemaps.org/attribution/) must appear in the app, and Foursquare's [NOTICE](https://opensource.foursquare.com/places-notice-txt/) with it |
| OpenStreetMap via Overpass | A venue's building outline (`import-venues.ts --osm`) | ODbL: "© OpenStreetMap contributors". Kept to the outline |
| Google Places | Nothing | Its terms allow storing only the place id ([terms](https://cloud.google.com/maps-platform/terms/maps-service-terms/index-20231025)) |
| Zomato, Swiggy, District, BookMyShow, Instagram, review sites | Nothing | Their terms forbid automated collection, and India's IT Act s.43(b) makes extracting data without permission actionable |

**No images and no prose come from any source** — decision 2 (`lib/curation.ts`), applied
to places as it is to curated events. An unclaimed venue shows its category art and the lit
map; its owner adds photos after claiming. A venue's name identifies it; no logos, and nothing
that implies the venue partners with Blendn.

## Running it

From the repo root, with the DuckDB CLI (`brew install duckdb`):

1. `duckdb < scripts/places/candidates.sql` — Overture places in the five boxes, filtered to
   nightlife, cafés, coworking, and restaurants that are also bars. About a minute; reads
   Overture's public S3 bucket anonymously. Writes `out/review/slug=<city>/data_0.csv`.
2. The review pass: Claude agents judge each row by [REVIEW.md](REVIEW.md) and write
   `out/decisions/`. A person reads a sample of every city before going on.
3. `duckdb < scripts/places/to-import.sql` — the kept rows, as `out/import/slug=<city>/data_0.csv`
   in the format `import-venues.ts` reads, plus `out/sports-bars.csv` for match nights.
4. `DATABASE_URL=… npx tsx scripts/import-venues.ts <file>` — a dry run; then `--apply`.
   Staging first, driven in the app, then production with the same files.

`out/` is gitignored: everything in it is regenerated from the pinned release.

## Refreshing

Overture publishes places monthly. Bump `release` in `candidates.sql` and run the same steps:
a record id already imported is skipped, so only new places reach the review. A claimed venue
is its owner's, and a refresh never touches it.

Not built yet: listing the unclaimed venues a new release marks `permanently_closed`, for an
admin to take down. `venues.source_record_id` is what that query will join on.
