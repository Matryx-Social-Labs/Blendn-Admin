# Building tiles for the home map

The home map's 3D buildings come from tiles we build and host ourselves, not from
OpenFreeMap. OpenFreeMap has two problems in central Bengaluru:

- about 90% of its buildings are a 5 m default slab;
- it merges thousands of outlines into one feature, so one building cannot be lit on its own.

These tiles fix both:

- every building is its own feature, with a numeric id the app can pass to `setFeatureState`;
- heights come from OSM where mappers tagged them, and from Google's 2.5D height raster everywhere else.

Research and reasoning: `3d-map-research.md` §1.2, §1.3, §1.6, §4 (orchestrator workspace,
`.context/plans/`). Jira: SCRUM-504, the home-map epic.

## What a tile holds

Static gzipped Mapbox Vector Tiles at `{z}/{x}/{y}.pbf`, **z14 only**. One layer, `building`.

| | |
|---|---|
| feature id | Numeric; one per building (its parts share it), across all cities (`id_offset` in `cities.json`). Assigned along a Hilbert curve, so neighbours have near numbers. **Not stable across versions**; `out/<city>/ids.parquet` maps Overture's GERS id to the tile id for one build |
| `render_height` | Metres, integer (ceil), same name as OpenMapTiles so the client's expressions carry over |
| `render_min_height` | Metres, integer; 0 for all but a few dozen buildings |

**Building parts.** OSM tags some landmarks as `building:part`s, for example a tower standing on a
podium. Each part is drawn as its own feature alongside its outline, **under the outline's id**:

- the two together draw the podium and the tower;
- `setFeatureState` on that one id lights the whole building;
- outline and parts share paint, so their coincident walls cannot visibly flicker.

There is no `hide_3d`. Bengaluru has 382 parts on 107 buildings. Leaving parts out cut the Public
Utility Building on MG Road from 106 m to its 10 m podium.

**Weight, Bengaluru `v2`:**

- 1,340,507 buildings in 256 tiles, 18.8 MB.
- Per tile: median 60 KB, p95 195 KB, max 277 KB, gzipped.
- The densest tiles:

  | Tile | These tiles | OpenFreeMap, whole tile |
  |---|---|---|
  | Indiranagar 14/11725/7596 (14,485 buildings) | 186 KB | 296 KB |
  | Koramangala 14/11724/7598 | 170 KB | 235 KB |
  | MG Road 14/11723/7596 | 94 KB | 262 KB |

- For comparison, Overture's published tiles weigh 412–938 KB for the same three tiles.
- The phone still downloads OpenFreeMap's tile for roads and labels, so these bytes come on top.

Clients set `maxzoom: 14` on the source so MapLibre overzooms past z14, the same as OpenFreeMap.
The layer's `minzoom` is 14, so z13 is not built.

## Height, in order of precedence

1. Overture `height`. In India this is always OSM's `height` tag.
2. Overture `num_floors` × 3.2 m. This is OSM's `building:levels`.
3. The baked height: the 75th percentile of Google Open Buildings 2.5D Temporal **2023**
   `building_height` inside the footprint, with coverage-weighted pixels (exactextract), read
   at 2 m. A value under 3 m counts as "no building here", not as a 1 m building. A value
   from 3 to 4 m is raised to 4 m.
4. 4 m.

`height_src` is recorded in `out/<city>/report.json` and never in the tiles.

**Why the 75th percentile.** It was chosen against the 13,373 Bengaluru buildings that OSM
mappers tagged with a height or a floor count. Results:

- Low-rise, floor-tagged (12,072): MAE 5.4 m, bias −1.2 m. The mean is biased −4.1 m,
  because the raster's soft edges pull it down.
- Towers: the raster flattens them. Buildings tagged 60–100 m have a median reading of 56 m.
  Buildings tagged over 100 m have a median reading of 0, either because they postdate the 2023
  imagery or because they are out of range. A tagged tower keeps its OSM height. An untagged one
  keeps the raster's: Prestige Kingfisher Towers stands 122 m and reads 93 m.

**Why 2 m and not 0.5 m.** The 0.5 m GeoTIFFs carry a signal at about 4 m effective resolution.
Their 2 m overview holds the same signal at 1/16 of the bytes: 16 tiles, 0.8 GB for Bengaluru.

## How good the heights are

`spot-check.json` lists 24 Bengaluru buildings with a published height or floor count, from
Wikipedia, CTBUH, SkyscraperPage and property listings. Floors are converted at × 3.2 m. Each
point sits inside its footprint. Run `--validate` to compare them with the build. Mean absolute
error in metres, 2026-10-09 (build `v2`):

| | n | OpenFreeMap today | **These tiles** | Raster alone |
|---|---|---|---|---|
| All | 24 | 14.5 | **9.1** | 24.2 |
| Towers, published ≥ 60 m | 11 | 19.9 | **11.9** | 42.3 |
| Mid-rise, 20–60 m | 6 | 11.9 | **8.2** | 14.0 |
| Low-rise, under 20 m | 7 | 8.2 | **5.4** | 4.5 |

**What the errors are made of:**

- **Towers are OSM's numbers.** Where OSM is wrong, the tiles are wrong too. UB City's Canberra
  is tagged 60 m and stands 105 m; Concorde reads 80 m and stands 115 m. The raster cannot rescue
  a tower, because it reads towers low.
- **Below 20 m, the raster is as good as OSM's floor tags.** Most of the city is below 20 m, and
  three in four Bengaluru buildings take their height from the raster.
- **One low-rise target is a floor-count lower bound.** Attara Kacheri has two tall heritage
  storeys, so its 6.4 m target is too low.

## Run it

You need `brew install duckdb tippecanoe` and [uv](https://docs.astral.sh/uv/). DuckDB here
runs through its Python package; the CLI is handy for poking at `out/`.

```bash
cd scripts/map-buildings
uv venv --python 3.13 .venv && uv pip install --python .venv/bin/python -r requirements.txt
.venv/bin/python build.py --self-test           # the height-precedence rules
.venv/bin/python build.py bengaluru             # overture -> rasters -> heights -> tiles, each step cached in out/bengaluru/
.venv/bin/python build.py bengaluru --validate  # spot-check.json vs the build; appends to report.json
.venv/bin/python build.py bengaluru --redo heights   # re-run one step and every step after it
```

**Bengaluru, measured 2026-10-09 on the 16 GB Mac:**

| Step | Time |
|---|---|
| Overture extract (1,340,507 buildings) | 3 min |
| Height rasters (16 GeoTIFFs, 0.8 GB) | 9 min, network-bound; first run only |
| Zonal heights + tiles | 7 min; peak RSS 1.6 GB |

A rebuild from the same inputs is byte-identical (checked on a central tile). Disk: 0.8 GB of
rasters and 0.35 GB of GeoJSONSeq, all under `out/`, which git ignores.

**Other cities** are an entry each in `cities.json`: `mumbai`, `delhi-ncr`, `hyderabad`, `pune`.
Each has its own `id_offset`, so ids never collide under one version prefix. **Keep city boxes from
overlapping**; a building in two boxes would get two ids. Hyderabad sits in UTM 44N; the raster
step picks each GeoTIFF's own CRS from Google's manifests.

## Upload

The tiles go to the public Tigris bucket, under a versioned prefix:

```bash
.venv/bin/python build.py bengaluru --upload v3          # dry run: counts, bytes, headers
railway run --service Blendn-Admin --environment staging -- \
  .venv/bin/python build.py bengaluru --upload v3 --apply
```

- `railway run` injects `TIGRIS_*`, and the script never prints them. Run it from a linked checkout:
  the railway CLI run from `/tmp` sees no project.
- Every object gets `Content-Type: application/x-protobuf`, `Content-Encoding: gzip` (tippecanoe
  gzips; the script refuses a tile that is not gzip) and `Cache-Control: public, max-age=31536000,
  immutable`.
- **A tile is never rewritten.** The public cache keeps an object for its Cache-Control, which is
  a year here. A rebuild therefore goes to the next version, and the script refuses to upload a tile
  that already exists.
- Cities can share a version: their boxes do not overlap, so neither do their tiles.

Live on staging (`v1` was withdrawn: it was built without building parts):

```
https://blendn-media-staging.fly.storage.tigris.dev/map/buildings/v2/{z}/{x}/{y}.pbf
```

- The bucket sends no CORS headers. The native app does not need them; a browser does.
- The prototype therefore loads the tiles through a local proxy (`.context/prototypes/3d-map/serve.py` in the orchestrator workspace).

Production is the same command against the production environment, once the client switch ships.

## Licences and the attribution the app must show

| Input | Version | Licence |
|---|---|---|
| Overture Maps buildings | release `2026-09-23.1` (pinned in `build.py`) | ODbL. Sources: OpenStreetMap (ODbL), Google Open Buildings (CC BY 4.0), Microsoft ML Buildings (ODbL per Overture; CDLA Permissive 2.0 upstream) |
| Google Open Buildings 2.5D Temporal | v1, year 2023 (`gs://open-buildings-temporal-data/v1`) | CC BY 4.0, chosen over ODbL. Google: "We have leveraged Copernicus Sentinel data (2016-2023) processed by the European Space Agency." |

- The tiles are a derived database of ODbL data, so **they stay ODbL**. Anyone may fetch them
  from the public bucket, which is fine under ODbL's share-alike.
- A rendered map needs only attribution.

Attribution text for the map:

> © OpenStreetMap contributors · Overture Maps Foundation · Google Open Buildings · Microsoft

- Sources: https://docs.overturemaps.org/attribution/ and
  https://sites.research.google/gr/open-buildings/temporal/.
- OpenFreeMap's own line stays for the base map.

## Refresh cadence and cost

**Refresh quarterly.** Overture keeps a release for 60 days
(https://docs.overturemaps.org/release-calendar/).

- Re-pin `OVERTURE_RELEASE`, rebuild, and upload to a new version.
- Then bump the client's `EXPO_PUBLIC_BUILDINGS_TILES_URL`.
- Old versions can be deleted once no supported app build points at them.
- The 2.5D raster is yearly, and 2023 is the latest year published. Re-check it once a year.

**Cost** (https://www.tigrisdata.com/pricing/):

- **Storage:** 18.8 MB for Bengaluru, inside the 5 GB free tier. All five cities are an estimate
  of well under 0.5 GB.
- **Egress:** $0.
- **Requests:** $0.0005 per 1,000 GETs. At research §4.4's upper bound of 20 sessions × 42 reads
  per user per month, that is about $4/mo at 10k MAU, $42 at 100k and $420 at 1M. The phone's
  tile cache makes the real number lower.
- **Building it:** engineering time only. All inputs are public, anonymous HTTP downloads.
