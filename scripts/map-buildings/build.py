#!/usr/bin/env python3
"""Slim 3D building tiles for the home map.

Overture footprints + Google Open Buildings 2.5D heights -> a static z14
{z}/{x}/{y}.pbf directory with one feature per building (and per building part, under the
building's id): a numeric id, render_height and render_min_height. See README.md.

    .venv/bin/python build.py bengaluru                 # every step, each cached in out/<city>/
    .venv/bin/python build.py bengaluru --redo heights  # rebuild one step and the ones after it
    .venv/bin/python build.py bengaluru --validate      # spot-check against spot-check.json
    .venv/bin/python build.py bengaluru --upload v3     # dry run; add --apply to write to Tigris
    .venv/bin/python build.py --self-test
"""
import argparse
import csv
import json
import math
import os
import shutil
import statistics
import subprocess
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
OVERTURE_RELEASE = "2026-09-23.1"
OVERTURE_URL = f"s3://overturemaps-us-west-2/release/{OVERTURE_RELEASE}/theme=buildings/type={{}}/*"
HEIGHTS_YEAR = 2023
GCS = "https://storage.googleapis.com/open-buildings-temporal-data"
RASTER_RES_M = 2  # the 0.5 m COGs carry a ~4 m signal; their 2 m overview keeps it at 1/16 of the bytes
FLOOR_M = 3.2
DEFAULT_M = 4
MIN_BAKED_M = 3  # below one storey the raster is saying "no building here", not "a 1 m building"
HEIGHT_STAT, HEIGHT_STAT_NAME = "quantile(q=0.75)", "quantile_75"  # least error against OSM-tagged buildings; README "Heights"
ZOOM = 14
STEPS = ["overture", "rasters", "heights", "tiles"]


def sql_bbox(b):
    return f"bbox.xmin < {b[2]} AND bbox.xmax > {b[0]} AND bbox.ymin < {b[3]} AND bbox.ymax > {b[1]}"


def duck():
    import duckdb

    con = duckdb.connect()
    con.execute("INSTALL spatial; LOAD spatial; INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2'; SET memory_limit='4GB'")
    return con


def utm_epsg(lon):
    return 32600 + int((lon + 180) // 6) + 1


# ---------- 1. Overture footprints ----------
def step_overture(city, cfg, out):
    con = duck()
    con.execute(f"""
      COPY (
        SELECT id, names.primary AS name, height, min_height, num_floors, min_floor, sources[1].dataset AS src, geometry
        FROM read_parquet('{OVERTURE_URL.format("building")}', hive_partitioning=1)
        WHERE {sql_bbox(cfg['bbox'])} AND NOT coalesce(is_underground, false)
      ) TO '{out}/overture.parquet' (FORMAT parquet, COMPRESSION zstd)""")
    # OSM building:part, e.g. a tower standing on a podium. Landmarks are tagged this way, so leaving
    # parts out flattened the Public Utility Building from 106 m to its 3-storey podium.
    con.execute(f"""
      COPY (
        SELECT p.id, building_id, p.height, p.min_height, p.num_floors, p.min_floor, p.geometry
        FROM read_parquet('{OVERTURE_URL.format("building_part")}', hive_partitioning=1) p
        SEMI JOIN '{out}/overture.parquet' b ON b.id = p.building_id
        WHERE {sql_bbox(cfg['bbox'])}
      ) TO '{out}/parts.parquet' (FORMAT parquet, COMPRESSION zstd)""")
    n, parts = (con.execute(f"SELECT count(*) FROM '{out}/{f}.parquet'").fetchone()[0] for f in ("overture", "parts"))
    print(f"overture: {n} buildings, {parts} building parts")


# ---------- 2. Google 2.5D height rasters ----------
def raster_tiles(bbox):
    """The year's GeoTIFFs that intersect bbox, as (url, crs, x0, y0, x1, y1), read from the dataset's manifests."""
    from pyproj import Transformer

    names = []
    url, token = f"{GCS.replace('storage.googleapis.com', 'storage.googleapis.com/storage/v1/b')}/o?prefix=v1/manifests/&fields=items(name),nextPageToken", ""
    while True:
        page = json.load(urllib.request.urlopen(url + (f"&pageToken={token}" if token else "")))
        names += [i["name"] for i in page.get("items", [])]
        token = page.get("nextPageToken")
        if not token:
            break
    zones = {utm_epsg(bbox[0]), utm_epsg(bbox[2])}
    found = []
    for name in names:
        if f"_{HEIGHTS_YEAR}_" not in name or not any(f"EPSG_{z}_" in name for z in zones):
            continue
        manifest = json.load(urllib.request.urlopen(f"{GCS}/{name}"))
        tileset = manifest["tilesets"][0]
        to_utm = Transformer.from_crs("EPSG:4326", tileset["crs"], always_xy=True)
        xs, ys = zip(*(to_utm.transform(x, y) for x in bbox[0::2] for y in bbox[1::2]))
        prefix = manifest["uriPrefix"].replace("gs://open-buildings-temporal-data", GCS)
        for s in tileset["sources"]:
            a, d = s["affineTransform"], s["dimensions"]
            x0, y1 = a["translateX"], a["translateY"]
            x1, y0 = x0 + d["width"] * a["scaleX"], y1 + d["height"] * a["scaleY"]
            if x0 < max(xs) and x1 > min(xs) and y0 < max(ys) and y1 > min(ys):
                found.append((prefix + s["uris"][0], tileset["crs"], x0, y0, x1, y1))
    return found


def fetch_raster(tile, dest):
    """Height and presence bands of one GeoTIFF at RASTER_RES_M, from its overview, over HTTP range reads."""
    import rasterio

    if dest.exists():
        return
    src = f"/vsicurl/{tile[0]}"
    with rasterio.open(src) as full:
        factor = round(RASTER_RES_M / full.res[0])
        level = full.overviews(1).index(factor)
        names = full.descriptions
    with rasterio.open(src, overview_level=level) as r:
        bands = [names.index("building_height") + 1, names.index("building_presence") + 1]
        profile = {**r.profile, "count": 2, "compress": "deflate", "predictor": 3, "tiled": True}
        tmp = dest.with_suffix(".part")
        with rasterio.open(tmp, "w", **profile) as w:
            w.write(r.read(bands))
            w.descriptions = ("building_height", "building_presence")
    tmp.rename(dest)
    print(f"  raster {dest.name}")


def step_rasters(city, cfg, out):
    tiles = raster_tiles(cfg["bbox"])
    (out / "rasters").mkdir(exist_ok=True)
    (out / "rasters.json").write_text(json.dumps(tiles, indent=1))
    os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
    with ThreadPoolExecutor(4) as pool:
        list(pool.map(lambda t: fetch_raster(t, out / "rasters" / (t[0].split("/")[-2] + "_" + Path(t[0]).name)), tiles))
    print(f"rasters: {len(tiles)} GeoTIFFs ({HEIGHTS_YEAR}, {RASTER_RES_M} m)")


# ---------- 3. One baked height per footprint ----------
def step_heights(city, cfg, out):
    import rasterio
    from exactextract import exact_extract

    con = duck()
    rows = []
    for t in json.loads((out / "rasters.json").read_text()):
        url, crs, x0, y0, x1, y1 = t
        path = out / "rasters" / (url.split("/")[-2] + "_" + Path(url).name)
        # Each footprint is measured on the GeoTIFF holding its centroid; the few that straddle a
        # 12.5 km tile edge are measured on the part inside it.
        feats = con.execute(f"""
          WITH g AS (SELECT id, ST_Transform(geometry, 'EPSG:4326', '{crs}', always_xy := true) AS g FROM '{out}/overture.parquet')
          SELECT id, ST_AsGeoJSON(g) FROM g
          WHERE ST_X(ST_Centroid(g)) >= {x0} AND ST_X(ST_Centroid(g)) < {x1}
            AND ST_Y(ST_Centroid(g)) >= {y0} AND ST_Y(ST_Centroid(g)) < {y1}""").fetchall()
        if not feats:
            continue
        geojson = [{"type": "Feature", "id": i, "properties": {}, "geometry": json.loads(g)} for i, g in feats]
        with rasterio.open(path) as r:  # band_1 is height (see fetch_raster); named ops segfault in exactextract 0.3.0
            res = exact_extract(r, geojson, [HEIGHT_STAT], include_cols=["id"])
        rows += [(f["id"], f["properties"][f"band_1_{HEIGHT_STAT_NAME}"]) for f in res]
        print(f"  {path.name}: {len(feats)} footprints")
    with open(out / "baked.csv", "w", newline="") as f:
        csv.writer(f).writerows([("id", "baked_h")] + [(i, "" if h is None or math.isnan(h) else round(h, 2)) for i, h in rows])
    con.execute(f"COPY (FROM read_csv('{out}/baked.csv', columns={{'id': 'VARCHAR', 'baked_h': 'DOUBLE'}}, header=true)) TO '{out}/baked.parquet' (FORMAT parquet)")
    print(f"heights: {len(rows)} footprints measured")


# ---------- 4. Height precedence + tiles ----------
def render_height_sql():
    """Overture/OSM height, then floors x FLOOR_M, then the baked 2.5D height, then DEFAULT_M."""
    return f"""CASE
      WHEN height > 0 THEN 'height' WHEN num_floors > 0 THEN 'floors'
      WHEN baked_h >= {MIN_BAKED_M} THEN 'baked' ELSE 'default' END AS height_src,
      ceil(CASE height_src WHEN 'height' THEN height WHEN 'floors' THEN num_floors * {FLOOR_M}
        WHEN 'baked' THEN greatest(baked_h, {DEFAULT_M}) ELSE {DEFAULT_M} END) AS h,
      floor(coalesce(min_height, min_floor * {FLOOR_M}, 0)) AS min_h"""


def step_tiles(city, cfg, out):
    con = duck()
    con.execute(f"""
      CREATE TABLE b AS
      SELECT o.id, o.geometry, o.height, o.num_floors, k.baked_h, {render_height_sql()}
      FROM '{out}/overture.parquet' o LEFT JOIN '{out}/baked.parquet' k USING (id)""")
    # Ids follow a Hilbert curve so neighbours get near numbers; small varints, readable in a debugger.
    xmin, ymin, xmax, ymax = cfg["bbox"]
    con.execute(f"""
      CREATE TABLE ids AS SELECT id, {cfg['id_offset']} + row_number() OVER (
        ORDER BY ST_Hilbert(ST_Centroid(geometry), {{'min_x': {xmin}, 'min_y': {ymin}, 'max_x': {xmax}, 'max_y': {ymax}}}::BOX_2D), id) AS fid FROM b""")
    con.execute(f"COPY ids TO '{out}/ids.parquet' (FORMAT parquet)")  # GERS id -> tile id, for this build only
    # Parts are extruded alongside their outline, under the outline's id: the union draws a podium and
    # its tower, and lighting the id lights all of it. Same paint, so their shared walls cannot flicker.
    con.execute(f"""
      CREATE TABLE f AS SELECT fid, geometry, h::INT AS h, least(min_h, h - 1)::INT AS min_h, src FROM (
        SELECT fid, geometry, h, min_h, height_src AS src FROM b JOIN ids USING (id)
        UNION ALL
        SELECT i.fid, p.geometry, ceil(coalesce(p.height, p.num_floors * {FLOOR_M}, b.h)),
               floor(coalesce(p.min_height, p.min_floor * {FLOOR_M}, 0)), 'part'
        FROM '{out}/parts.parquet' p JOIN ids i ON i.id = p.building_id JOIN b ON b.id = p.building_id)""")
    con.execute(f"COPY f TO '{out}/features.parquet' (FORMAT parquet)")  # exactly what the tiles draw; --validate reads it
    seq = out / "buildings.geojsonseq"
    con.execute(f"""
      COPY (SELECT 'Feature' AS type, ST_AsGeoJSON(geometry)::JSON AS geometry,
              {{'fid': fid, 'render_height': h, 'render_min_height': min_h}} AS properties FROM f ORDER BY fid)
      TO '{seq}' (FORMAT json)""")
    tiles = out / "tiles"
    shutil.rmtree(tiles, ignore_errors=True)
    subprocess.run(["tippecanoe", "-e", str(tiles), "-l", "building", f"-Z{ZOOM}", f"-z{ZOOM}",
                    "--use-attribute-for-id=fid", "--no-feature-limit", "--no-tile-size-limit",
                    "--detect-shared-borders", "-P", "--quiet", "--force", str(seq)], check=True)
    by_src = dict(con.execute("SELECT src, count(*) FROM f GROUP BY 1").fetchall())
    write_report(out, {"buildings": sum(v for k, v in by_src.items() if k != "part"), "height_src": by_src})


def tile_sizes(tiles):
    return {"/".join(p.relative_to(tiles).with_suffix("").parts): p.stat().st_size for p in tiles.rglob("*.pbf")}


def write_report(out, extra):
    sizes = tile_sizes(out / "tiles")
    kb = sorted(s / 1024 for s in sizes.values())
    report = {
        "overture_release": OVERTURE_RELEASE, "heights": f"Open Buildings 2.5D Temporal {HEIGHTS_YEAR}, {HEIGHT_STAT} at {RASTER_RES_M} m",
        **extra,
        "tiles": len(sizes), "total_mb": round(sum(sizes.values()) / 2**20, 1),
        "kb_per_tile": {"median": round(statistics.median(kb), 1), "p95": round(kb[int(len(kb) * 0.95)], 1), "max": round(kb[-1], 1)},
        "kb_central": {k: round(sizes.get(v, 0) / 1024, 1) for k, v in CENTRAL_TILES.items()},
    }
    (out / "report.json").write_text(json.dumps(report, indent=1))
    print(json.dumps(report, indent=1))


CENTRAL_TILES = {"indiranagar": "14/11725/7596", "koramangala": "14/11724/7598", "mg_road": "14/11723/7596"}


# ---------- validation ----------
def validate(city, cfg, out):
    """Each spot-check point -> the tallest drawn feature over it, and the raw baked height, vs the published height."""
    con = duck()
    checks = json.loads((HERE / "spot-check.json").read_text())
    rows = []
    for c in checks:
        expected = c["height_m"] if c.get("height_m") else c["floors"] * FLOOR_M
        pt = f"ST_Point({c['lon']}, {c['lat']})"
        h, src = con.execute(f"SELECT max(h), string_agg(DISTINCT src, '+') FROM '{out}/features.parquet' WHERE ST_Contains(geometry, {pt})").fetchone()
        if h is None:
            print(f"  no footprint: {c['name']}")
            continue
        baked = con.execute(f"""SELECT max(baked_h) FROM '{out}/overture.parquet' o JOIN '{out}/baked.parquet' USING (id)
                                WHERE ST_Contains(o.geometry, {pt})""").fetchone()[0]
        rows.append({"name": c["name"], "expected": round(expected, 1), "render_height": h, "src": src,
                     "baked": None if baked is None else round(baked, 1)})
    for r in rows:
        print(f"  {r['name'][:40]:40} expected {r['expected']:6.1f}  tiles {r['render_height']:5.0f} ({r['src']:7})  baked {r['baked']}")
    mae = lambda key, rs: round(statistics.mean(abs(r[key] - r["expected"]) for r in rs), 1) if rs else None
    baked = [r for r in rows if r["baked"] is not None]
    summary = {"n": len(rows), "mae_render_height_m": mae("render_height", rows),
               "n_baked": len(baked), "mae_baked_only_m": mae("baked", baked), "rows": rows}
    report = json.loads((out / "report.json").read_text())
    (out / "report.json").write_text(json.dumps({**report, "validation": summary}, indent=1))
    print({k: v for k, v in summary.items() if k != "rows"})


# ---------- upload ----------
def upload(city, out, version, apply):
    """Every tile to the public bucket under map/buildings/<version>/. Immutable: a rebuild needs a new version."""
    tiles = out / "tiles"
    files = sorted(tiles.rglob("*.pbf"))
    prefix = f"map/buildings/{version}"
    headers = {"ContentType": "application/x-protobuf", "ContentEncoding": "gzip",
               "CacheControl": "public, max-age=31536000, immutable"}
    for p in files:  # tippecanoe gzips every tile; a raw one would be served with a lying header
        with open(p, "rb") as f:
            if f.read(2) != b"\x1f\x8b":
                sys.exit(f"{p} is not gzipped")
    total = sum(p.stat().st_size for p in files)
    print(f"{len(files)} tiles, {total / 2**20:.1f} MB -> {prefix}/{{z}}/{{x}}/{{y}}.pbf  {headers}")
    if not apply:
        print("dry run: nothing written; add --apply")
        return
    import boto3

    bucket = os.environ["TIGRIS_BUCKET"]
    s3 = boto3.client("s3", endpoint_url=os.environ["TIGRIS_ENDPOINT"], region_name=os.environ.get("TIGRIS_REGION", "auto"),
                      aws_access_key_id=os.environ["TIGRIS_ACCESS_KEY"], aws_secret_access_key=os.environ["TIGRIS_SECRET_KEY"])
    key = lambda p: f"{prefix}/{p.relative_to(tiles).as_posix()}"
    pages = s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix + "/")
    existing = {o["Key"] for page in pages for o in page.get("Contents", [])}
    if existing & {key(p) for p in files}:  # another city may share the version; nothing is ever overwritten
        sys.exit(f"{prefix}/ already has these tiles; the public cache keeps old tiles for a year, so use a new version")

    def put(p):
        s3.put_object(Bucket=bucket, Key=key(p), Body=p.read_bytes(), **headers)

    with ThreadPoolExecutor(16) as pool:
        list(pool.map(put, files))
    print(f"uploaded to https://{bucket}.fly.storage.tigris.dev/{prefix}/{{z}}/{{x}}/{{y}}.pbf")


def self_test():
    con = duck()
    cases = [  # height, floors, baked, min_height -> (src, h)
        ((30.2, 9, 50.0, None), ("height", 31)),
        ((None, 4, 50.0, None), ("floors", 13)),
        ((None, None, 17.3, None), ("baked", 18)),
        ((None, None, 3.1, None), ("baked", 4)),
        ((None, None, 2.9, None), ("default", 4)),
        ((None, None, None, None), ("default", 4)),
        ((0.0, 0, 9.0, None), ("baked", 9)),
    ]
    for (height, floors, baked, min_height), want in cases:
        got = con.execute(f"SELECT height_src, h FROM (SELECT {render_height_sql()} FROM (SELECT ?::DOUBLE height, "
                          f"?::INT num_floors, ?::DOUBLE baked_h, ?::DOUBLE min_height, NULL::INT min_floor))",
                          [height, floors, baked, min_height]).fetchone()
        assert (got[0], int(got[1])) == want, (height, floors, baked, got, want)
    print("self-test ok")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("city", nargs="?")
    ap.add_argument("--redo", choices=STEPS)
    ap.add_argument("--validate", action="store_true")
    ap.add_argument("--upload", metavar="VERSION")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    if a.self_test:
        return self_test()
    cities = json.loads((HERE / "cities.json").read_text())
    if a.city not in cities:
        sys.exit(f"city must be one of {', '.join(cities)}")
    cfg, out = cities[a.city], HERE / "out" / a.city
    out.mkdir(parents=True, exist_ok=True)
    if a.upload:
        return upload(a.city, out, a.upload, a.apply)
    if a.validate:
        return validate(a.city, cfg, out)
    done = {"overture": out / "overture.parquet", "rasters": out / "rasters.json", "heights": out / "baked.parquet", "tiles": out / "report.json"}
    redo = STEPS[STEPS.index(a.redo):] if a.redo else []
    for step in STEPS:
        if step in redo or not done[step].exists():
            print(f"== {step}")
            globals()[f"step_{step}"](a.city, cfg, out)


if __name__ == "__main__":
    main()
