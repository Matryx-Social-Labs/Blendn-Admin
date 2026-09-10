"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import { themeColour } from "@/lib/theme-colour"
import type { Map as LeafletMap, LayerGroup, TileLayer } from "leaflet"
import {
  IconBuildingCommunity,
  IconCircleDashed,
  IconPolygon,
  IconRefresh,
} from "@tabler/icons-react"

import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import {
  DEFAULT_ACCURACY_POLICY,
  GEOFENCE_LIMITS,
  fenceCentre,
  ringSelfIntersects,
  type Geofence,
} from "@/lib/geofence"

/**
 * Drawing a check-in area.
 *
 * The screen this product's core mechanic depends on. It exists to make three
 * separate quantities visible as three separate things, because they were one
 * number before and no single number works for both a 20m café and a 200m
 * stadium:
 *
 *   - **extent** (solid orange) — the venue itself
 *   - **buffer** (dashed rose) — the organiser's deliberate tolerance
 *   - **accuracy allowance** (dotted grey) — added per attendee, automatically
 *
 * The third ring is the one that changes behaviour. Once an organiser can see
 * that GPS noise is handled for them, they stop drawing the shape "bigger to be
 * safe" — which is how a real football match on production ended up with a
 * **100km radius**, covering most of Karnataka.
 *
 * There is no "GPS check-in off" switch. Physical presence is the product.
 *
 * ponytail: Leaflet is driven imperatively through refs, matching
 * `location-picker.tsx`. react-leaflet would be a dependency to re-express what
 * forty lines of effect already does.
 */

const ACCURACY_CAP = DEFAULT_ACCURACY_POLICY.cap

/*
 * Read from the tokens rather than copied from them.
 *
 * These were the light-theme hexes, hardcoded, on a dark-pinned app — and three
 * of the five are brand values that already exist in `globals.css` twice, with
 * the dark pair deliberately lifted so the purple carries against `#0D0C0C`.
 *
 * A function rather than a constant because `getComputedStyle` needs a
 * document: at module scope this would run during SSR and bake the fallback in.
 */
function colours() {
  return {
    extent: themeColour("--chart-1", "#F05423"),
    buffer: themeColour("--chart-2", "#BE5C71"),
    accuracy: themeColour("--muted-foreground", "#9a948f"),
    other: themeColour("--chart-3", "#8F49AA"),
    bad: themeColour("--destructive", "#e5484d"),
    // The handle outline. `--background` is the app's ink, so it tracks the theme
    // rather than assuming the dark one.
    ink: themeColour("--background", "#0D0C0C"),
  }
}

export interface GeofenceEditorProps {
  value: Geofence | null
  onChange: (fence: Geofence) => void
  /** Where to centre when there is nothing drawn yet. */
  fallbackCentre?: { lat: number; lng: number }
  /** A concurrent event's fence, drawn dashed purple as an overlap warning. */
  overlap?: { name: string; organiser: string; fence: Geofence } | null
  editable?: boolean
  height?: number
}

export function GeofenceEditor({
  value,
  onChange,
  fallbackCentre = { lat: 12.9716, lng: 77.5946 },
  overlap = null,
  editable = true,
  height = 420,
}: GeofenceEditorProps) {
  /*
   * Resolved in the body rather than at module scope: `getComputedStyle` needs a
   * document, and at module scope this would evaluate once during SSR and bake
   * the fallbacks in for the life of the process.
   */
  const COLOURS = colours()

  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<LeafletMap | null>(null)
  const layerRef = useRef<LayerGroup | null>(null)
  const tilesRef = useRef<{ map?: TileLayer; sat?: TileLayer }>({})
  const leafletRef = useRef<typeof import("leaflet") | null>(null)

  const [layer, setLayer] = useState<"map" | "sat">("map")
  const [showAccuracy, setShowAccuracy] = useState(true)
  const [drawing, setDrawing] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importNote, setImportNote] = useState<string | null>(null)

  const fence: Geofence = value ?? {
    type: "circle",
    lat: fallbackCentre.lat,
    lng: fallbackCentre.lng,
    radius: 30,
    buffer: 20,
  }

  /*
   * Read by Leaflet's event handlers, which are registered once on mount and
   * would otherwise close over the first render's values forever.
   *
   * Written in an effect rather than during render: mutating a ref while
   * rendering is not safe under concurrent React, and the compiler rejects it.
   * An effect is early enough — it runs before any click can reach a handler.
   */
  const stateRef = useRef({ fence, editable, drawing, onChange })
  useEffect(() => {
    stateRef.current = { fence, editable, drawing, onChange }
  }, [fence, editable, drawing, onChange])

  const crossed = fence.type === "polygon" && ringSelfIntersects(fence.ring)

  /* ---------------------------------------------------------------- map --- */

  useEffect(() => {
    let cancelled = false
    let cleanup: (() => void) | undefined

    void import("leaflet").then((L) => {
      if (cancelled || !containerRef.current || mapRef.current) return
      leafletRef.current = L

      const map = L.map(containerRef.current, { zoomControl: true })
      const centre =
        fence.type === "circle"
          ? ([fence.lat, fence.lng] as [number, number])
          : centroid(fence.ring)
      // A stadium at z18 fills the screen with one corner of itself.
      const wide = fence.type === "circle" ? fence.radius > 100 : spanOf(fence.ring) > 150
      map.setView(centre, wide ? 16 : 18)

      tilesRef.current = {
        map: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
          attribution: "© OpenStreetMap",
        }),
        sat: L.tileLayer(
          "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
          { maxZoom: 19, attribution: "Esri" }
        ),
      }
      tilesRef.current.map!.addTo(map)
      layerRef.current = L.layerGroup().addTo(map)

      map.on("click", (e) => {
        const s = stateRef.current
        if (!s.editable || !s.drawing) return
        const ring =
          s.fence.type === "polygon" ? [...s.fence.ring] : ([] as [number, number][])
        ring.push([e.latlng.lat, e.latlng.lng])
        s.onChange({ type: "polygon", ring, buffer: s.fence.buffer })
      })

      mapRef.current = map
      setTimeout(() => map.invalidateSize(), 50)
      const observer = new ResizeObserver(() => map.invalidateSize())
      observer.observe(containerRef.current)
      cleanup = () => {
        observer.disconnect()
        map.remove()
        mapRef.current = null
      }
    })

    return () => {
      cancelled = true
      cleanup?.()
    }
    // Mount once. Shape changes are drawn by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const map = mapRef.current
    const tiles = tilesRef.current
    if (!map || !tiles.map || !tiles.sat) return
    if (layer === "sat") {
      map.removeLayer(tiles.map)
      tiles.sat.addTo(map)
    } else {
      map.removeLayer(tiles.sat)
      tiles.map.addTo(map)
    }
  }, [layer])

  /* --------------------------------------------------------------- draw --- */

  useEffect(() => {
    const L = leafletRef.current
    const group = layerRef.current
    if (!L || !group) return
    group.clearLayers()

    const handle = (size: number, fill: string, border: string) =>
      L.divIcon({
        className: "",
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
        html: `<div style="width:${size}px;height:${size}px;border-radius:${
          fill === COLOURS.extent ? "999px" : "3px"
        };background:${fill};border:2px solid ${border};box-shadow:0 1px 4px rgba(0,0,0,.5)"></div>`,
      })

    if (overlap) {
      const o = overlap.fence
      const shape =
        o.type === "circle"
          ? L.circle([o.lat, o.lng], { radius: o.radius + o.buffer })
          : L.polygon(o.ring)
      shape
        .setStyle({
          color: COLOURS.other,
          weight: 2,
          dashArray: "5 5",
          fillColor: COLOURS.other,
          fillOpacity: 0.1,
        })
        .addTo(group)
        .bindTooltip(`${overlap.name} — ${overlap.organiser}`, { direction: "top" })
    }

    if (fence.type === "circle") {
      const centre: [number, number] = [fence.lat, fence.lng]
      if (showAccuracy) {
        L.circle(centre, {
          radius: fence.radius + fence.buffer + ACCURACY_CAP,
          color: COLOURS.accuracy,
          weight: 1.5,
          dashArray: "2 7",
          fill: false,
          opacity: 0.55,
        }).addTo(group)
      }
      L.circle(centre, {
        radius: fence.radius + fence.buffer,
        color: COLOURS.buffer,
        weight: 2,
        dashArray: "7 6",
        fill: false,
        opacity: 0.9,
      }).addTo(group)
      L.circle(centre, {
        radius: fence.radius,
        color: COLOURS.extent,
        weight: 2.5,
        fillColor: COLOURS.extent,
        fillOpacity: 0.16,
      }).addTo(group)

      if (editable) {
        const centreMarker = L.marker(centre, {
          draggable: true,
          icon: handle(14, COLOURS.extent, "#fff"),
        }).addTo(group)
        centreMarker.on("dragend", (e) => {
          const p = (e.target as L.Marker).getLatLng()
          const s = stateRef.current.fence
          if (s.type === "circle") onChange({ ...s, lat: p.lat, lng: p.lng })
        })

        const edge = destination(centre, 90, fence.radius)
        const radiusMarker = L.marker(edge, {
          draggable: true,
          icon: handle(13, "#fff", COLOURS.ink),
        }).addTo(group)
        radiusMarker.bindTooltip("Drag to set the radius", { direction: "right" })
        radiusMarker.on("dragend", (e) => {
          const p = (e.target as L.Marker).getLatLng()
          const s = stateRef.current.fence
          if (s.type !== "circle") return
          const r = Math.round(metresBetween([s.lat, s.lng], [p.lat, p.lng]))
          onChange({ ...s, radius: Math.min(GEOFENCE_LIMITS.MAX_RADIUS, Math.max(5, r)) })
        })
      }
    } else if (fence.ring.length > 0) {
      const closed = fence.ring.length >= 3 && !drawing
      if (closed) {
        // The buffer and allowance are drawn as fat strokes rather than true
        // offset polygons — offsetting a concave ring correctly needs a
        // clipper library, and at these widths the difference is invisible.
        const lat = fence.ring[0][0]
        const zoom = mapRef.current?.getZoom() ?? 18
        const px = (m: number) => Math.max(1, (2 * m) / metresPerPixel(lat, zoom))
        if (showAccuracy) {
          L.polygon(fence.ring, {
            fill: false,
            color: COLOURS.accuracy,
            opacity: 0.16,
            weight: px(fence.buffer + ACCURACY_CAP),
            lineJoin: "round",
          }).addTo(group)
        }
        L.polygon(fence.ring, {
          fill: false,
          color: COLOURS.buffer,
          opacity: 0.3,
          weight: px(fence.buffer),
          lineJoin: "round",
        }).addTo(group)
        L.polygon(fence.ring, {
          color: crossed ? COLOURS.bad : COLOURS.extent,
          weight: 2.5,
          fillColor: COLOURS.extent,
          fillOpacity: 0.16,
        }).addTo(group)
      } else {
        L.polyline(fence.ring, {
          color: COLOURS.extent,
          weight: 2.5,
          dashArray: "6 5",
        }).addTo(group)
      }

      if (editable) {
        fence.ring.forEach((point, i) => {
          const first = i === 0 && drawing && fence.ring.length >= 3
          const marker = L.marker(point, {
            draggable: true,
            icon: handle(first ? 16 : 12, "#fff", crossed ? COLOURS.bad : COLOURS.ink),
          }).addTo(group)
          if (first) marker.bindTooltip("Click to close the outline", { direction: "top" })

          marker.on("click", () => {
            if (first) setDrawing(false)
          })
          // Right-click removes, keeping at least a triangle.
          marker.on("contextmenu", (e) => {
            L.DomEvent.preventDefault(e as unknown as Event)
            const s = stateRef.current.fence
            if (s.type !== "polygon" || s.ring.length <= 3) return
            onChange({ ...s, ring: s.ring.filter((_, k) => k !== i) })
          })
          marker.on("dragend", (e) => {
            const p = (e.target as L.Marker).getLatLng()
            const s = stateRef.current.fence
            if (s.type !== "polygon") return
            onChange({
              ...s,
              ring: s.ring.map((q, k) => (k === i ? [p.lat, p.lng] : q)) as [number, number][],
            })
          })
        })
      }
    }

    if (containerRef.current) {
      containerRef.current.style.cursor = editable && drawing ? "crosshair" : ""
    }

    /*
     * Follow the fence when it leaves the view.
     *
     * The view is set once, at mount. That is right while somebody is dragging
     * a corner, and wrong the moment the fence moves somewhere else entirely —
     * which is exactly what picking a listed venue does: `inherit` copies the
     * venue's geofence, the shape is redrawn faithfully, and it is redrawn
     * off-screen. The organiser is left looking at a check-in area over the
     * wrong part of the city, on a form whose whole job is getting that area
     * right.
     *
     * Only when it is outside the current bounds, so nudging a shape near the
     * edge does not yank the map out from under the cursor.
     */
    const map = mapRef.current
    if (map) {
      const centre =
        fence.type === "circle"
          ? ([fence.lat, fence.lng] as [number, number])
          : centroid(fence.ring)
      if (!map.getBounds().contains(L.latLng(centre[0], centre[1]))) {
        const wide = fence.type === "circle" ? fence.radius > 100 : spanOf(fence.ring) > 150
        map.setView(centre, wide ? 16 : 18)
      }
    }
  }, [fence, showAccuracy, overlap, editable, drawing, crossed, onChange])

  /* ------------------------------------------------------ OSM footprint --- */

  /**
   * Pull the building outline OpenStreetMap already has.
   *
   * The best drawing UX is not needing to draw. Verified against Overpass: M
   * Chinnaswamy Stadium has a 67-vertex outline, and named cafés in Indiranagar
   * have footprints too — so for most venues this is one click instead of a
   * skill to learn. Tracing by hand stays for everywhere OSM does not cover.
   */
  const importFootprint = useCallback(async () => {
    const centre =
      fence.type === "circle" ? [fence.lat, fence.lng] : centroid(fence.ring)
    setImporting(true)
    setImportNote(null)
    try {
      const query = `[out:json][timeout:20];(way["building"](around:60,${centre[0]},${centre[1]});way["leisure"="stadium"](around:250,${centre[0]},${centre[1]}););out geom 8;`
      const res = await fetch("https://overpass-api.de/api/interpreter", {
        method: "POST",
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(25_000),
      })
      const body = (await res.json()) as {
        elements?: { geometry?: { lat: number; lon: number }[] }[]
      }
      // Largest footprint wins — a stadium's own outline beats a kiosk inside it.
      const best = (body.elements ?? [])
        .map((e) => (e.geometry ?? []).map((g) => [g.lat, g.lon] as [number, number]))
        .filter((ring) => ring.length >= 4)
        .sort((a, b) => spanOf(b) - spanOf(a))[0]

      if (!best) {
        setImportNote("No building outline here in OpenStreetMap — trace it by hand.")
        return
      }
      // Overpass closes ways by repeating the first point; our ring must not.
      const ring = best.slice(0, -1).slice(0, GEOFENCE_LIMITS.MAX_RING)
      if (ringSelfIntersects(ring)) {
        setImportNote("That outline crosses itself — trace it by hand instead.")
        return
      }
      onChange({ type: "polygon", ring, buffer: fence.buffer })
      setDrawing(false)
      setImportNote(`Imported a ${ring.length}-corner outline. Drag any corner to adjust.`)
    } catch {
      setImportNote("Couldn't reach OpenStreetMap. Trace it by hand, or try again.")
    } finally {
      setImporting(false)
    }
  }, [fence, onChange])

  /* --------------------------------------------------------------- view --- */

  const mode = fence.type === "circle" ? "circle" : "polygon"

  function switchMode(next: string) {
    if (next === mode) return
    if (next === "polygon") {
      setDrawing(true)
      setLayer("sat")
      onChange({ type: "polygon", ring: [], buffer: fence.buffer })
    } else {
      setDrawing(false)
      const centre =
        fence.type === "polygon" && fence.ring.length ? centroid(fence.ring) : [fallbackCentre.lat, fallbackCentre.lng]
      onChange({
        type: "circle",
        lat: centre[0],
        lng: centre[1],
        radius: 30,
        buffer: fence.buffer,
      })
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {editable ? (
        <div className="flex flex-wrap items-center gap-2.5">
          <Tabs value={mode} onValueChange={switchMode}>
            <TabsList>
              <TabsTrigger value="circle">
                <IconCircleDashed className="size-4" /> Circle
              </TabsTrigger>
              <TabsTrigger value="polygon">
                <IconPolygon className="size-4" /> Trace outline
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <span className="text-[0.71875rem] text-faint-foreground">
            {mode === "circle"
              ? "Fast — right for most venues."
              : "For stadiums, campuses, rooftops — anywhere a circle lies."}
          </span>
          <div className="flex-1" />
          <Button size="sm" variant="outline" onClick={importFootprint} disabled={importing}>
            <IconBuildingCommunity className="size-4" />
            {importing ? "Looking…" : "Use building outline"}
          </Button>
        </div>
      ) : null}

      <div className="relative overflow-hidden rounded-xl border border-border-strong">
        {/*
          OpenStreetMap's own unloaded-tile colour, deliberately not a brand
          token: this is what the map looks like before tiles arrive, and
          matching the app's surface would make a loading map read as a broken
          one. The literal is the map's, not the design system's.
        */}
        <div ref={containerRef} style={{ height }} className="bg-[#e8e4de]" />

        <div className="absolute right-2.5 top-2.5 z-[800] flex overflow-hidden rounded-lg border border-border-strong bg-background/90 p-0.5 backdrop-blur">
          {(["map", "sat"] as const).map((k) => (
            <button
              key={k}
              // Not the shared `Button`, so it does not inherit that default.
              // Without this, changing the map layer submits the event form.
              type="button"
              onClick={() => setLayer(k)}
              className={cn(
                "rounded-md px-2.5 py-1 text-[0.71875rem]",
                layer === k ? "bg-surface-raised font-bold" : "text-muted-foreground"
              )}
            >
              {k === "map" ? "Map" : "Satellite"}
            </button>
          ))}
        </div>

        {editable && drawing ? (
          <div className="pointer-events-none absolute left-1/2 top-2.5 z-[800] -translate-x-1/2 whitespace-nowrap rounded-lg border border-border-strong bg-background/90 px-3 py-1.5 text-[0.71875rem] backdrop-blur">
            {fence.type === "polygon" && fence.ring.length === 0
              ? "Click the map to start tracing the venue outline"
              : fence.type === "polygon" && fence.ring.length < 3
                ? `${fence.ring.length} of 3 points minimum — keep clicking`
                : "Click your first point to close the outline"}
          </div>
        ) : null}

        {crossed ? (
          <div className="pointer-events-none absolute left-1/2 top-2.5 z-[800] -translate-x-1/2 whitespace-nowrap rounded-lg border border-destructive bg-background/90 px-3 py-1.5 text-[0.71875rem] text-destructive backdrop-blur">
            Outline crosses itself — drag a corner until the edges untangle
          </div>
        ) : null}

        <div className="pointer-events-none absolute bottom-2.5 left-2.5 z-[800] flex flex-col gap-1.5 rounded-lg border border-border-strong bg-background/90 px-3 py-2 text-[0.71875rem] backdrop-blur">
          <Legend colour={COLOURS.extent} dash="solid" label="Extent — the venue itself" />
          <Legend colour={COLOURS.buffer} dash="dashed" label={`Buffer — your tolerance (${fence.buffer} m)`} />
          {showAccuracy ? (
            <Legend
              colour={COLOURS.accuracy}
              dash="dotted"
              label={`GPS allowance — automatic, up to ${ACCURACY_CAP} m`}
            />
          ) : null}
          {overlap ? (
            <Legend colour={COLOURS.other} dash="dashed" label={`${overlap.name} (concurrent)`} />
          ) : null}
        </div>
      </div>

      {importNote ? (
        <p className="text-[0.75rem] text-muted-foreground">{importNote}</p>
      ) : null}

      {editable ? (
        <div className="grid gap-4 @2xl/main:grid-cols-2 @2xl/main:gap-7">
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center gap-2 text-[0.8125rem]">
              <span className="font-bold">{describe(fence)}</span>
              {fence.type === "polygon" && fence.ring.length > 0 ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setDrawing(true)
                    onChange({ type: "polygon", ring: [], buffer: fence.buffer })
                  }}
                >
                  <IconRefresh className="size-3.5" /> Start over
                </Button>
              ) : null}
            </div>
            <p className="text-[0.75rem] text-faint-foreground">
              {fence.type === "circle"
                ? "Drag the centre dot to move it, the white handle to resize. Draw the venue as it actually is — not bigger to be safe."
                : "Drag a corner to adjust, right-click one to remove it."}
            </p>

            <label className="flex flex-col gap-1.5">
              <span className="text-[0.78125rem] font-medium text-muted-foreground">
                Buffer — <b className="text-foreground">{fence.buffer} m</b> beyond the extent
              </span>
              <Slider
                min={0}
                max={GEOFENCE_LIMITS.MAX_BUFFER}
                step={5}
                value={[fence.buffer]}
                onValueChange={([v]) => onChange({ ...fence, buffer: v })}
                aria-label="Buffer in metres"
                className="max-w-80"
              />
              <span className="text-[0.71875rem] text-faint-foreground">
                The queue, the pavement, the car park — deliberate tolerance, your call.
              </span>
            </label>
          </div>

          <div className="flex flex-col gap-2 border-border text-[0.78125rem] text-muted-foreground @2xl/main:border-l @2xl/main:pl-6">
            <span className="text-[0.8125rem] font-bold text-foreground">
              GPS noise is handled for you
            </span>
            <p>
              At check-in each phone reports how accurate its own fix is — typically 5–65 m
              indoors. That reading, capped at {ACCURACY_CAP} m, is added on top of your buffer{" "}
              <b>automatically, per attendee</b>. So someone up to ~{fence.buffer + ACCURACY_CAP} m
              out may get in on a bad-GPS day, and that is correct behaviour rather than a bug.
            </p>
            <label className="flex items-center gap-2">
              <Switch checked={showAccuracy} onCheckedChange={setShowAccuracy} />
              <span>Show the allowance on the map</span>
            </label>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function Legend({ colour, dash, label }: { colour: string; dash: string; label: string }) {
  return (
    <span className="flex items-center gap-2">
      <span
        aria-hidden
        className="w-4 shrink-0"
        style={{ borderTop: `2.5px ${dash} ${colour}` }}
      />
      <span>{label}</span>
    </span>
  )
}

/* ------------------------------------------------------------- helpers --- */

/**
 * Ring centroid as the tuple Leaflet wants, with a default for an empty ring.
 *
 * The arithmetic moved to `lib/geofence.ts` — it was living here *and* inline
 * in `boundingCircle`, and a third copy was about to be written for resolving
 * an event's city. This is now only an adapter.
 *
 * The fallback stays here on purpose. `fenceCentre` returns null for a ring
 * with no points, because a guessed coordinate is harmless when it decides
 * where to point a camera and a lie when it lands in a database column.
 */
function centroid(ring: [number, number][]): [number, number] {
  const centre = fenceCentre({ type: "polygon", ring, buffer: 0 })
  return centre ? [centre.lat, centre.lng] : [12.9716, 77.5946]
}

const R = 6_371_000
const rad = (d: number) => (d * Math.PI) / 180

function metresBetween(a: [number, number], b: [number, number]): number {
  const dLat = rad(b[0] - a[0])
  const dLng = rad(b[1] - a[1])
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

function destination(from: [number, number], bearing: number, metres: number): [number, number] {
  const b = rad(bearing)
  const lat = rad(from[0])
  const lng = rad(from[1])
  const d = metres / R
  const lat2 = Math.asin(Math.sin(lat) * Math.cos(d) + Math.cos(lat) * Math.sin(d) * Math.cos(b))
  const lng2 =
    lng + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat), Math.cos(d) - Math.sin(lat) * Math.sin(lat2))
  return [(lat2 * 180) / Math.PI, (lng2 * 180) / Math.PI]
}

function metresPerPixel(lat: number, zoom: number): number {
  return (40_075_016.686 * Math.cos(rad(lat))) / 2 ** (zoom + 8)
}

/** Widest span across a ring, in metres. */
function spanOf(ring: [number, number][]): number {
  if (ring.length < 2) return 0
  const c = centroid(ring)
  return ring.reduce((m, p) => Math.max(m, metresBetween(c, p)), 0) * 2
}

function describe(fence: Geofence): string {
  if (fence.type === "circle") return `circle · ${Math.round(fence.radius)} m radius`
  if (fence.ring.length < 3) {
    return `${fence.ring.length} point${fence.ring.length === 1 ? "" : "s"}`
  }
  return `traced outline · ${fence.ring.length} corners · ~${Math.round(spanOf(fence.ring))} m across`
}
