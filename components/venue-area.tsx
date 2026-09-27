"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"
import type { venue_type } from "@prisma/client"

import { AreaSourceLine, type AreaSource } from "@/components/area-source-line"
import { AreaControls } from "@/components/event-form/area-controls"
import { WhereSearch, type PickedPlace } from "@/components/event-form/where-search"
import { GeofenceEditor } from "@/components/geofence-editor"
import { DEFAULT_BUFFER_M, fenceCentre, sameShape, type Geofence } from "@/lib/geofence"
import { defaultExtentMetres } from "@/lib/venue-types"

type LatLng = { lat: number; lng: number }

/**
 * A venue's place and check-in area (SCRUM-354): the event form's address →
 * outline flow, on the venue pages.
 *
 * One search for the place. Its outline arrives on its own — OpenStreetMap's,
 * else the building at the pin (`/api/footprint`), else a circle sized for the
 * venue type — and the line under the map says which. The buffer is the
 * default every event here starts with. The shape takes drags only while
 * "Adjust area" is open.
 *
 * Controlled: the page keeps the record. `onPlace` gets the picked place's
 * words; `onArea` gets every change to the area and, once the area is a place,
 * its centre — which is the venue's pin, so pin and outline cannot drift apart
 * (SCRUM-204).
 */
export function VenueArea({
  fence,
  venueType,
  editable,
  fallbackCentre,
  onPlace,
  onArea,
  caption,
}: {
  fence: Geofence | null
  venueType: venue_type | null
  editable: boolean
  fallbackCentre?: LatLng
  onPlace: (place: PickedPlace) => void
  onArea: (fence: Geofence, pin: LatLng | null) => void
  /** Under the citation: the address, written by the place. */
  caption?: ReactNode
}) {
  const [query, setQuery] = useState("")
  const [source, setSource] = useState<AreaSource | null>(null)
  const [adjusting, setAdjusting] = useState(false)
  /** Only the newest building lookup may draw; a later pick or a drawing wins. */
  const footprintSeq = useRef(0)
  useEffect(() => () => {
    footprintSeq.current++
  }, [])
  /** The area as it is now: a lookup that lands late keeps a buffer changed meanwhile (React review). */
  const latest = useRef(fence)
  useEffect(() => {
    latest.current = fence
  }, [fence])

  function setArea(next: Geofence) {
    // A ring still being drawn is not a place: the pin waits for three corners.
    const unfinished = next.type === "polygon" && next.ring.length < 3
    onArea(next, unfinished ? null : fenceCentre(next))
  }

  function pick(place: PickedPlace) {
    const mine = ++footprintSeq.current
    setAdjusting(false)
    setQuery(place.name)
    onPlace(place)
    // The venue keeps its own buffer when its place is corrected.
    const buffer = fence?.buffer ?? DEFAULT_BUFFER_M
    const { lat, lng, outline } = place.location
    if (outline) {
      setArea({ type: "polygon", ring: outline, buffer })
      setSource("osm-area")
      return
    }
    setArea({ type: "circle", lat, lng, radius: defaultExtentMetres(venueType ?? place.venueType), buffer })
    setSource("circle")
    fetch(`/api/footprint?lat=${lat}&lon=${lng}`)
      .then((res) => (res.ok ? (res.json() as Promise<{ ring: [number, number][] | null }>) : { ring: null }))
      .then(({ ring }) => {
        if (mine !== footprintSeq.current || !ring) return
        setArea({ type: "polygon", ring, buffer: latest.current?.buffer ?? buffer })
        setSource("building")
      })
      .catch(() => {
        // The circle stays, and the citation already says there was no outline.
      })
  }

  function onFenceChange(next: Geofence, how?: "import") {
    ++footprintSeq.current
    if (how === "import") setSource("building")
    else if (!fence || !sameShape(fence, next)) setSource("drawn")
    setArea(next)
  }

  /** The area when Adjust opened: closing it on an outline of fewer than three corners puts it back. */
  const beforeAdjust = useRef<{ fence: Geofence | null; source: AreaSource | null }>({ fence: null, source: null })
  function adjust(open: boolean) {
    if (open) beforeAdjust.current = { fence, source }
    else if (fence?.type === "polygon" && fence.ring.length < 3 && beforeAdjust.current.fence) {
      setArea(beforeAdjust.current.fence)
      setSource(beforeAdjust.current.source)
    }
    setAdjusting(open)
  }

  const legend = fence
    ? {
        extent:
          fence.type === "circle"
            ? `Circle — ${Math.round(fence.radius)} m`
            : adjusting
              ? "Outline — drag a corner"
              : "The venue's outline",
        buffer: `Buffer — ${fence.buffer} m, the default every event here starts with`,
      }
    : undefined

  return (
    <div className="flex flex-col gap-2">
      {editable ? (
        <WhereSearch
          listed={false}
          label="Place or address"
          placeholder="Place or address — its building is found for you"
          value={query}
          selected={null}
          onTextChange={setQuery}
          onPickVenue={() => {}}
          onPickPlace={pick}
          onClear={() => setQuery("")}
        />
      ) : null}
      <GeofenceEditor
        value={fence}
        onChange={onFenceChange}
        editable={editable && adjusting}
        fallbackCentre={fallbackCentre}
        legend={legend}
        caption={
          <div className="flex flex-col gap-2">
            <AreaSourceLine source={source} fence={fence} whose="every-event" saved="The venue's outline" />
            {caption}
          </div>
        }
        controls={(tools) =>
          editable ? (
            <AreaControls
              mode="venue"
              fence={fence}
              onBuffer={(buffer) => fence && setArea({ ...fence, buffer })}
              adjusting={adjusting}
              onAdjusting={adjust}
              adjustLabel="Adjust area"
              tools={tools}
            />
          ) : null
        }
      />
    </div>
  )
}
