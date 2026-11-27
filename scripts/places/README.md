# Seeding venues from open data

Places people go to meet, in Bengaluru, Mumbai, Delhi NCR, Hyderabad and Pune, from
Overture Maps. Every venue is live from day one (owner ruling, 2026-10-01): seeded
unclaimed, claimed later by its owner at `/claim/venue/<id>`.

## Sources, and the ones we do not use

One row per source dataset. "Where we credit it" is where the credit is shown today; a source
whose data reaches no screen yet says so. Licence wording is quoted from the pages linked,
read 2026-11-27; where a licence's reach is a legal question, the row says so and
`~/.blendn-qa/launch/OWNER.md` holds the question.

| Source | Used for | Licence and what it asks | Where we credit it |
|---|---|---|---|
| [Overture Maps places](https://docs.overturemaps.org/guides/places/) | Name, point, address, category, brand, website | CDLA-Permissive-2.0 or Apache-2.0 by provider; no OSM data, no share-alike. Each provider's line from [the attribution page](https://docs.overturemaps.org/attribution/) must appear in the app, and Foursquare's [NOTICE](https://opensource.foursquare.com/places-notice-txt/) with it | Not yet: the app's attribution screen (SCRUM-702) comes before any production import |
| [Overture Maps buildings](https://docs.overturemaps.org/guides/buildings/), release `2026-11-18.0` | A seeded, unclaimed venue's check-in outline (`scripts/backfill-venue-fences.ts`, `buildings.sql`) | ODbL: "Because it includes OpenStreetMap data, the buildings theme is published under the ODbL license." Overture's line: "© OpenStreetMap contributors, Overture Maps Foundation", and "Some of the data sources we use in Overture datasets require their own attribution, according to their licenses" (the rows below) | The check-in area editor's map corner (`MAP_CREDIT`, `lib/map-credit.ts`), on every editor map: no column says which fence came from Overture. "Overture Maps Foundation" links to its attribution page, which carries every source's own line |
| ↳ OpenStreetMap, inside Overture buildings (8,724 of 10,014 in the 2026-11-26 dry run) | The same outlines | [ODbL](https://www.openstreetmap.org/copyright): "Provide credit to OpenStreetMap by displaying our attribution notice" and "Make clear that the data is available under the Open Database License", which a link to the copyright page does | The editor's map corner: "© OpenStreetMap contributors", OpenStreetMap linked to the copyright page |
| ↳ [Google Open Buildings](https://sites.research.google/gr/open-buildings/), inside Overture buildings (910) | The same outlines | CC BY 4.0 or ODbL, "you can pick which of the two licenses you prefer"; Overture lists it under CC BY 4.0. CC BY 4.0 §3(a)(2): the attribution may be given "by providing a URI or hyperlink to a resource that includes the required information" | Through the Overture link in the editor's corner (its attribution page names Google Open Buildings and its licence). That this is enough is the default, not a legal finding: OWNER.md |
| ↳ [Microsoft Global ML Building Footprints](https://github.com/microsoft/GlobalMLBuildingFootprints), inside Overture buildings (375) | The same outlines | Microsoft's README: "This data is licensed by Microsoft under the CDLA Permissive 2.0", which "does not impose any restriction or obligations with respect to the use, modification, or sharing of Results"; Overture's page lists it as "Licensed by Microsoft under the Open Database License". We follow the stricter, ODbL | The Overture line in the editor's corner; the two licence statements disagree, noted in OWNER.md |
| ↳ City of Vancouver, inside Overture buildings (5) | The same outlines | [Open Government Licence – Vancouver](https://opendata.vancouver.ca/pages/licence/): acknowledge the source with the provider's statement "and, where possible, provide a link to this licence"; with several providers, "Contains information licensed under the Open Government Licence – Vancouver." | Through the Overture link (its attribution page carries that statement). Whether a link is enough is OWNER.md's question, answered before the backfill is applied; if not, the apply leaves these five out |
| Other Overture building sources (Esri Community Maps, Spain IGN, an East Asia ML set) | Nothing yet: no venue matched one in the 2026-11-26 dry run | Each has its own line on Overture's attribution page | A refresh that matches one adds its row here first |
| OpenStreetMap via Overpass and Nominatim | The editor's live "Find the building" (`/api/footprint`, `lib/outline.ts`) and address search, and the editor's map tiles | ODbL, as above; the [tile policy](https://operations.osmfoundation.org/policies/tiles/) asks for the same credit | The editor's map corner and the location picker's, both linked to the copyright page |
| Google Places | Nothing | Its terms allow storing only the place id ([terms](https://cloud.google.com/maps-platform/terms/maps-service-terms/index-20231025)) | Nothing to credit |
| Zomato, Swiggy, District, BookMyShow, Instagram, review sites | Nothing | Their terms forbid automated collection, and India's IT Act s.43(b) makes extracting data without permission actionable | Nothing to credit |

**Outlines are shown in the dashboard editor only.** The app receives a derived check-in
radius, never the outline (`phoneCheckInRadius`), and no public page, API or export carries
one. If that changes, the Overture and source credits above are owed there too: the app's
event and venue maps, a public venue page on blendn.app, and any API or export that returns
`geofence`. An ODbL read comes first for a public one (the extracted outlines may count as a
database that must be shared alike): OWNER.md.

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
   Every venue starts with a circle sized for its type; building outlines come after, from
   Overture buildings (`scripts/backfill-venue-fences.ts`). Staging first, driven in the app, then production with the same files.

### Another country

`candidates.sql` runs one country at a time: `PLACES_COUNTRY=CA duckdb < scripts/places/candidates.sql`.
Add the country's city boxes to `all_cities` there, matching the `cities` rows (`/dashboard/markets`).
A city must be in the catalogue before its venues import: `import-venues.ts` refuses any other
city, and writes each venue's `timezone` from its catalogue city (the column's default is
Asia/Kolkata, so a Toronto bar would otherwise open "tonight" in IST).

Canada on staging (2026-11-01) skipped the agent review: the decisions are REVIEW.md's
mechanical rules only (confidence 0.8 or more; no wine or liquor stores, McCafé counters or
airport lounges), with reason `canada staging pass: rule not read`. Production needs the full
review pass and a person's sample read first, and waits on SCRUM-702 like India's import.

`out/` is gitignored: everything in it is regenerated from the pinned release.

## Refreshing

Overture publishes places monthly. Bump `release` in `candidates.sql` and run the same steps:
a record id already imported is skipped, so only new places reach the review. A claimed venue
is its owner's, and a refresh never touches it.

Not built yet: listing the unclaimed venues a new release marks `permanently_closed`, for an
admin to take down. `venues.source_record_id` is what that query will join on.
