"use client"

import { useEffect, useRef, useState } from "react"
import type { UseFormReturn } from "react-hook-form"
import { IconAlertTriangle } from "@tabler/icons-react"
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { GeofenceEditor } from "@/components/geofence-editor"
import { AreaControls } from "@/components/event-form/area-controls"
import { areaAfterPick, DEFAULT_BUFFER_M, fenceCentre, GEOFENCE_LIMITS, phoneCheckInRadius, samePlace, sameShape, type Geofence } from "@/lib/geofence"
import type { LocationData } from "@/components/location-picker"
import { FormSection } from "@/components/event-form/form-section"
import type { EventFormValues } from "@/components/event-form/schema"
import { WhereSearch, type PickedPlace } from "@/components/event-form/where-search"
import { venueById, type VenueOption } from "@/lib/venue-actions"
import { validateGeofence } from "@/lib/geofence"
import { extractAddress } from "@/lib/address"

export function LocationSection({
  form,
  onLocationChange,
}: {
  form: UseFormReturn<EventFormValues>
  onLocationChange: (data: LocationData) => void
}) {
  /*
   * `watch`, not `getValues` — robustness, and NOT the bug.
   *
   * The obvious story is that `getValues` does not subscribe, so the pin never
   * heard about a picked venue. That story is wrong, and the recorded control
   * is what showed it: reverting this line to `getValues` leaves
   * `e2e/venue-pin.spec.ts` **passing**. The section re-renders anyway, because
   * `venue_id` two lines below is watched and changes at the same moment, and
   * `getValues` is re-read during that render.
   *
   * So it worked by coincidence — one field's subscription carrying another
   * field's value. The actual defect was in `LocationPicker`, whose map effect
   * had `[]` deps and could not act on a changed prop however it arrived.
   *
   * `watch` stays because depending on a sibling's re-render is a trap: remove
   * or memoise that `venue_id` watch and the pin silently stops following,
   * with nothing in this file to explain why.
   */
  const initialLat = form.watch("latitude")
  const initialLng = form.watch("longitude")

  /** How far the pin moved when it left an outline behind; null when nothing was cleared. */
  const [movedKm, setMovedKm] = useState<number | null>(null)
  const reverseSeq = useRef(0)
  /** Where the area came from — the caption under the map cites it (SCRUM-353). */
  const [areaSource, setAreaSource] = useState<AreaSource | null>(null)
  /** Only the newest building lookup may draw; a later pick or a drawing wins. */
  const footprintSeq = useRef(0)
  // And none after the section has gone: a late answer is ignored.
  useEffect(() => () => {
    footprintSeq.current++
  }, [])
  const geofence = (form.watch("geofence") as Geofence | null) ?? null
  /** "Adjust area" is open — only then does the shape take drags (SCRUM-353: adjust only if wrong). */
  const [adjusting, setAdjusting] = useState(false)
  /** The organiser chose Custom. A buffer other than the base reads as custom too. */
  const [customChosen, setCustomChosen] = useState(false)

  /**
   * The app judges the area as a circle of `check_in_radius` around the pin, so
   * it follows the area — outline or circle, grown and shrunk with it, buffer
   * included — never a number of its own (SCRUM-350). Measured from the area's
   * centre, which is where this section puts the pin. The server derives it
   * again on save; this copy is what the readiness checks read. Capped at the
   * schema's limit so a campus-sized outline cannot silently block the save.
   */
  function setFence(fence: Geofence | null) {
    form.setValue("geofence", fence, { shouldDirty: true })
    const covering = fence ? phoneCheckInRadius({ geofence: fence }) : null
    if (covering != null) form.setValue("check_in_radius", Math.min(covering, GEOFENCE_LIMITS.MAX_RADIUS))
  }

  /**
   * The pin moved by a search or a venue pick. The address comes with it, and
   * so does the area: a circle follows, an outline left behind becomes a
   * circle on the pin — and the caption says how far, so the organiser knows
   * why their outline went.
   */
  function moveTo(location: LocationData) {
    // A place OSM holds as an area comes with its outline (SCRUM-351): that is
    // the check-in area, at the default buffer — a new place starts from the
    // base, not from the last place's choice — and the pin is its centre. The
    // address the search wrote stays.
    if (location.outline) {
      const fence: Geofence = { type: "polygon", ring: location.outline, buffer: DEFAULT_BUFFER_M }
      const centre = fenceCentre(fence) ?? { lat: location.lat, lng: location.lng }
      onLocationChange({ ...location, lat: centre.lat, lng: centre.lng })
      setFence(fence)
      setMovedKm(null)
      setAreaSource("osm-area")
      return
    }
    onLocationChange(location)
    const { fence, movedKm: moved } = areaAfterPick(
      (form.getValues("geofence") as Geofence | null) ?? null,
      { lat: location.lat, lng: location.lng }
    )
    setFence(fence)
    setMovedKm(lostDrawing(areaSource) ? moved : null)
  }

  function setBuffer(buffer: number) {
    if (geofence) setFence({ ...geofence, buffer })
  }

  /** The area when Adjust opened: closing Adjust on an outline of fewer than three corners puts it back. */
  const beforeAdjust = useRef<{ fence: Geofence | null; source: AreaSource | null }>({ fence: null, source: null })
  function adjust(open: boolean) {
    if (open) beforeAdjust.current = { fence: geofence, source: areaSource }
    else if (geofence?.type === "polygon" && geofence.ring.length < 3) {
      setFence(beforeAdjust.current.fence)
      setAreaSource(beforeAdjust.current.source)
    }
    setAdjusting(open)
  }

  /**
   * The area was drawn or dragged on the map. The pin is its centre — the
   * columns the attendee app sorts "Nearby" by and puts its marker on — and a
   * dragged circle brings the address with it, the way dragging the old pin did.
   */
  function onFenceChange(fence: Geofence, how?: "import") {
    ++footprintSeq.current
    // The citation stays true: the editor's own import is a building, a new
    // shape is drawn, and a buffer nudge keeps whatever it cited before.
    const prev = form.getValues("geofence") as Geofence | null
    if (how === "import") setAreaSource("building")
    else if (!prev || !sameShape(prev, fence)) setAreaSource("drawn")
    const lat = form.getValues("latitude")
    const lng = form.getValues("longitude")
    const before = lat == null || lng == null ? null : { lat, lng }
    setFence(fence)
    if (fence.type === "polygon") setMovedKm(null)
    // A ring still being drawn is not a place yet: its first click or two
    // would move the pin — and rewrite the address — to wherever they landed.
    // `fenceCentre` answers for one point, so the ring's length decides.
    if (fence.type === "polygon" && fence.ring.length < 3) return
    const centre = fenceCentre(fence)
    if (!centre) return
    form.setValue("latitude", centre.lat)
    form.setValue("longitude", centre.lng)
    if (samePlace(before, fence)) return
    const mine = ++reverseSeq.current
    fetch(`/api/geocode?lat=${centre.lat}&lon=${centre.lng}`, { headers: { "Accept-Language": "en" } })
      .then((res) => res.json())
      .then((hit) => {
        if (mine !== reverseSeq.current) return
        const resolved = extractAddress(centre.lat, centre.lng, hit)
        onLocationChange({
          lat: centre.lat,
          lng: centre.lng,
          address: resolved.address,
          city: resolved.city,
          state: resolved.state,
          country: resolved.country,
          postal_code: resolved.postalCode,
        })
      })
      .catch(() => {
        // The pin moved; a failed lookup only leaves the old words, which the
        // organiser can edit. Not worth an error over.
      })
  }
  const [venue, setVenue] = useState<VenueOption | null>(null)
  const venueId = form.watch("venue_id")
  /** A linked venue that could not be loaded: its buffer is unknown, so the default stands in. */
  const [unloadedVenueId, setUnloadedVenueId] = useState<string | null>(null)

  // Editing an existing linked event: the id is on the form, the venue is not.
  useEffect(() => {
    if (!venueId || venue?.id === venueId) return
    let cancelled = false
    venueById(venueId)
      .then((v) => {
        if (cancelled) return
        if (v) setVenue(v)
        else setUnloadedVenueId(venueId)
      })
      .catch(() => {
        // A failed lookup leaves the free-text name showing, which is still
        // correct — the link is on the form either way.
        if (!cancelled) setUnloadedVenueId(venueId)
      })
    return () => {
      cancelled = true
    }
  }, [venueId, venue?.id])

  /**
   * Picking a venue fills what the venue already knows.
   *
   * Verify-once, not hide: everything below stays editable, because an event on
   * the rooftop of a three-floor venue legitimately differs from the venue's
   * own footprint.
   */
  function inherit(picked: VenueOption) {
    ++footprintSeq.current
    // A pick starts from the venue's own area and buffer, shape locked until
    // "Adjust for this event".
    setAdjusting(false)
    setCustomChosen(false)
    setVenue(picked)
    form.setValue("venue_id", picked.id)
    // auto_linked, not confirmed — the organiser picked the venue, but nobody
    // has confirmed this event actually belongs to it. The owner's dispute path
    // reads this.
    form.setValue("venue_link_status", "auto_linked")
    form.setValue("venue_name", picked.name)
    if (picked.address) form.setValue("address", picked.address)
    if (picked.city) form.setValue("city", picked.city)
    if (picked.lat !== null && picked.lng !== null) {
      form.setValue("latitude", picked.lat)
      form.setValue("longitude", picked.lng)
      // Keeps the map pin in step. The remaining address parts stay as the
      // organiser left them — the venue record does not carry them.
      onLocationChange({
        lat: picked.lat,
        lng: picked.lng,
        address: picked.address ?? form.getValues("address") ?? "",
        city: picked.city ?? form.getValues("city") ?? null,
        state: form.getValues("state") ?? null,
        country: form.getValues("country") ?? null,
        postal_code: form.getValues("postal_code") ?? null,
      })
    }
    // Prefill only when empty. Overwriting a capacity the organiser already
    // typed would silently change the number they meant.
    if (!form.getValues("max_capacity") && picked.capacity) {
      form.setValue("max_capacity", picked.capacity)
    }
    // The check-in area is a property of the place, and was being redrawn per
    // event. Validated rather than trusted — it came from the database, but so
    // did the 100km radius.
    const own = picked.geofence ? validateGeofence(picked.geofence) : null
    if (own?.ok) {
      setFence(own.fence)
      setMovedKm(null)
      setAreaSource("venue")
    } else if (picked.lat !== null && picked.lng !== null) {
      // A venue with no area of its own: the one the form has follows the pin.
      const { fence, movedKm: moved } = areaAfterPick(
        (form.getValues("geofence") as Geofence | null) ?? null,
        { lat: picked.lat, lng: picked.lng }
      )
      setFence(fence)
      setMovedKm(lostDrawing(areaSource) ? moved : null)
    }
  }

  /**
   * A new place from the geocoder: it becomes the event's venue name and
   * location. A place OSM holds as an area brought its outline (`moveTo`); a
   * pin — a bar, a club — asks for the building it sits in (SCRUM-351), and
   * keeps the circle, saying so, when OSM has none.
   */
  function pickPlace({ name, location }: PickedPlace) {
    setAdjusting(false)
    setCustomChosen(false)
    if (venue) unlink()
    form.setValue("venue_name", name, { shouldDirty: true })
    moveTo(location)
    if (location.outline) return
    setAreaSource("circle")
    const mine = ++footprintSeq.current
    fetch(`/api/footprint?lat=${location.lat}&lon=${location.lng}`)
      .then((res) => (res.ok ? (res.json() as Promise<{ ring: [number, number][] | null }>) : { ring: null }))
      .then(({ ring }) => {
        if (mine !== footprintSeq.current || !ring) return
        const current = form.getValues("geofence") as Geofence | null
        const fence: Geofence = { type: "polygon", ring, buffer: current?.buffer ?? DEFAULT_BUFFER_M }
        const centre = fenceCentre(fence)
        if (centre) {
          form.setValue("latitude", centre.lat)
          form.setValue("longitude", centre.lng)
        }
        setFence(fence)
        setMovedKm(null)
        setAreaSource("building")
      })
      .catch(() => {
        // The circle stays, and the caption already says there was no outline.
      })
  }

  function unlink() {
    setVenue(null)
    form.setValue("venue_id", null)
    form.setValue("venue_link_status", null)
    // The name, location and geofence stay — the organiser typed an event at
    // this place, and clearing it all would punish them for unlinking.
  }

  // Until the linked venue loads, its buffer is unknown: the choice would read
  // "Custom" against the default and offer the default as the base.
  const venuePending = !!venueId && venue?.id !== venueId && unloadedVenueId !== venueId
  const venueArea = venue?.geofence ? validateGeofence(venue.geofence) : null
  /** The buffer a pick starts from: the venue's own, else the default (owner's ruling 3). */
  const venueBuffer = venueArea?.ok ? venueArea.fence.buffer : null
  const baseBuffer = venueBuffer ?? DEFAULT_BUFFER_M
  const custom = customChosen || (geofence != null && geofence.buffer !== baseBuffer)
  const whose: BufferWhose = custom ? "custom" : venueBuffer != null ? "venue" : "default"
  const legend = geofence
    ? {
        extent:
          geofence.type === "circle"
            ? `Circle — ${Math.round(geofence.radius)} m`
            : adjusting
              ? "Outline — drag a corner"
              : areaSource === "venue"
                ? "The venue's outline"
                : "The outline",
        buffer: `Buffer — ${geofence.buffer} m, ${{ venue: "the venue's", default: "the default", custom: "custom" }[whose]}`,
      }
    : undefined

  const capacity = form.watch("max_capacity")
  const overVenueCapacity =
    venue?.capacity != null && capacity != null && capacity > venue.capacity

  return (
    <FormSection step="03" title="Where" hint="check-in counts inside the ring" id="step-where">
      <FormField
        control={form.control}
        name="venue_name"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Venue or address</FormLabel>
            <FormControl>
              <WhereSearch
                value={field.value ?? ""}
                selected={venue}
                onTextChange={field.onChange}
                onPickVenue={inherit}
                onPickPlace={pickPlace}
                onClear={unlink}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      {overVenueCapacity ? (
        <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 px-3.5 py-2.5 text-[0.78125rem]">
          <IconAlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
          <span>
            {venue!.name} is listed at {venue!.capacity} and this event is set to {capacity}. A
            warning, not a block — the venue figure is the room&rsquo;s maximum and may be out of
            date.
          </span>
        </p>
      ) : null}

      {/*
        One map (the owner's call, 2026-09-27). There were two: a location map
        with its own pin and its own circle, and this check-in area map. They
        disagreed — moving the pin only moved the area while none had been
        drawn — so an event could save a pin in one place and a fence in
        another. Now the address is typed on this map, the pin is the area's
        centre, and the address under the map is written by the pin.

        The wrapper still carries the pin as data attributes:
        `e2e/venue-pin.spec.ts` proves a venue pick moves the pin by reading
        them here.
      */}
      <div className="flex flex-col gap-2" data-lat={initialLat ?? ""} data-lng={initialLng ?? ""}>
        <p className="sr-only">Location and check-in area</p>
        <GeofenceEditor
          value={geofence}
          onChange={onFenceChange}
          editable={adjusting}
          legend={legend}
          controls={(tools) => (
            <AreaControls
              fence={venuePending ? null : geofence}
              base={baseBuffer}
              baseIsVenue={venueBuffer != null}
              custom={custom}
              onBase={() => {
                setCustomChosen(false)
                setBuffer(baseBuffer)
              }}
              onCustom={() => setCustomChosen(true)}
              onBuffer={setBuffer}
              adjusting={adjusting}
              onAdjusting={adjust}
              adjustLabel={venue ? "Adjust for this event" : "Adjust area"}
              tools={tools}
            />
          )}
          fallbackCentre={
            initialLat != null && initialLng != null ? { lat: initialLat, lng: initialLng } : undefined
          }
          caption={
            <FormField
              control={form.control}
              name="address"
              render={({ field }) => (
                <FormItem>
                  <AreaSourceLine source={areaSource} fence={geofence} whose={whose} />
                  <FormLabel className="sr-only">Address</FormLabel>
                  {/* Controlled from the first render: a new event has no address until a pick writes one. */}
                  <FormControl>
                    <Input placeholder="The address — written by the pin; edit if the street is wrong" {...field} value={field.value ?? ""} />
                  </FormControl>
                  <DerivedLine form={form} />
                  {movedKm != null ? (
                    <p role="status" className="flex items-baseline gap-2 text-[0.8125rem]">
                      <span className="size-1.5 shrink-0 translate-y-[-1px] rounded-full bg-warning" aria-hidden />
                      <span>
                        Outline cleared — the pin moved {movedKm} km.{" "}
                        <span className="text-muted-foreground">Adjust the area to draw it or find the building again.</span>
                      </span>
                    </p>
                  ) : null}
                  <FormMessage />
                </FormItem>
              )}
            />
          }
        />
      </div>
    </FormSection>
  )
}

/**
 * City, region, country and postal code, as one line.
 *
 * They come from the map and are not typed: every city-scoped query groups
 * by them, so a typo would split a city in the app's browse list. The escape
 * hatch is the pin, not the text — a wrong city means a wrong pin, and the
 * pin is also what the fence and the distance sort use.
 */
function DerivedLine({ form }: { form: UseFormReturn<EventFormValues> }) {
  const parts = [form.watch("city"), form.watch("state"), form.watch("country"), form.watch("postal_code")]
    .map((v) => v?.trim())
    .filter(Boolean)
  return (
    <p className="text-[0.8125rem] text-muted-foreground">
      {parts.length ? (
        <>
          <span className="text-foreground">{parts.join(" · ")}</span> — from the pin
        </>
      ) : (
        "City, region and postal code come from the pin."
      )}
    </p>
  )
}

type AreaSource = "venue" | "osm-area" | "building" | "circle" | "drawn"
type BufferWhose = "venue" | "default" | "custom"

/**
 * Whether an outline a pick leaves behind was somebody's work — drawn by hand,
 * or the event's saved area. Only then does "Outline cleared" say so: moving
 * from one picked place to another is the choice itself, and the new area is
 * cited under the map.
 */
const lostDrawing = (source: AreaSource | null) => source === "drawn" || source === null


/**
 * The area cites its source — the section's memorable detail (SCRUM-353 design
 * chain). One line under the map, like a citation: where the outline came
 * from, its size, and the buffer. A circle that stands in for a missing
 * outline says so, in the warning tone, and asks for the building.
 */
function AreaSourceLine({ source, fence, whose }: { source: AreaSource | null; fence: Geofence | null; whose: BufferWhose }) {
  if (!fence) return null
  const shape =
    fence.type === "polygon" ? `${fence.ring.length} corners` : `a ${Math.round(fence.radius)} m circle`
  const buffer = `+${fence.buffer} m, ${{ venue: "the venue's buffer", default: "the default buffer", custom: "custom for this event" }[whose]}`
  const said: Record<AreaSource | "saved", string> = {
    venue: "Area from the venue",
    "osm-area": "Outline from OpenStreetMap",
    building: "Building outline found nearby",
    circle: "No outline in OpenStreetMap",
    drawn: "Drawn on the map",
    saved: "The event's saved area",
  }
  const warn = source === "circle"
  return (
    <p className="flex flex-wrap items-baseline gap-x-2 text-[0.8125rem]" data-area-source={source ?? "saved"}>
      <span className={warn ? "size-1.5 shrink-0 translate-y-[-1px] rounded-full bg-warning" : "size-1.5 shrink-0 translate-y-[-1px] rounded-full bg-primary"} aria-hidden />
      <span className={warn ? "font-medium text-warning" : "font-medium"}>{said[source ?? "saved"]}</span>
      <span className="text-muted-foreground">
        · {warn ? `${shape} at the address — adjust the area to draw the building` : shape} · {buffer}
      </span>
    </p>
  )
}

