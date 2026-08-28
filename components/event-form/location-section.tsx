"use client"

import { useEffect, useState } from "react"
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
import { fenceCentre, type Geofence } from "@/lib/geofence"
import { LocationPicker, type LocationData } from "@/components/location-picker"
import { FormSection } from "@/components/event-form/form-section"
import type { EventFormValues } from "@/components/event-form/schema"
import { VenuePicker } from "@/components/event-form/venue-picker"
import { venueById, type VenueOption } from "@/lib/venue-actions"
import { validateGeofence } from "@/lib/geofence"
import { DEFAULT_CHECK_IN_RADIUS_M } from "@/lib/constants"

export function LocationSection({
  form,
  onLocationChange,
}: {
  form: UseFormReturn<EventFormValues>
  onLocationChange: (data: LocationData) => void
}) {
  const checkInRadius = form.watch("check_in_radius") ?? DEFAULT_CHECK_IN_RADIUS_M
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

  const [venue, setVenue] = useState<VenueOption | null>(null)
  const venueId = form.watch("venue_id")

  // Editing an existing linked event: the id is on the form, the venue is not.
  useEffect(() => {
    if (!venueId || venue?.id === venueId) return
    let cancelled = false
    venueById(venueId)
      .then((v) => {
        if (!cancelled && v) setVenue(v)
      })
      .catch(() => {
        // A failed lookup leaves the free-text name showing, which is still
        // correct — the link is on the form either way.
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
    if (picked.geofence) {
      const parsed = validateGeofence(picked.geofence)
      if (parsed.ok) form.setValue("geofence", parsed.fence)
    }
  }

  function unlink() {
    setVenue(null)
    form.setValue("venue_id", null)
    form.setValue("venue_link_status", null)
    // The name, location and geofence stay — the organiser typed an event at
    // this place, and clearing it all would punish them for unlinking.
  }

  const capacity = form.watch("max_capacity")
  const overVenueCapacity =
    venue?.capacity != null && capacity != null && capacity > venue.capacity

  return (
    <FormSection title="Location">
      <FormField
        control={form.control}
        name="venue_name"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Venue</FormLabel>
            <FormControl>
              <VenuePicker
                value={field.value ?? ""}
                selected={venue}
                onTextChange={field.onChange}
                onSelect={inherit}
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

      <div>
        <FormLabel>Map Location</FormLabel>
        <div className="mt-2">
          <LocationPicker
            initialLat={initialLat}
            initialLng={initialLng}
            checkInRadius={checkInRadius}
            onLocationChange={onLocationChange}
          />
        </div>
      </div>

      {/* Auto-filled address fields (read-only display, editable as fallback) */}
      <div className="grid grid-cols-2 gap-4">
        <FormField
          control={form.control}
          name="address"
          render={({ field }) => (
            <FormItem className="col-span-2">
              <FormLabel>Address</FormLabel>
              <FormControl>
                <Input placeholder="Auto-filled from map" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        {/*
          Derived from the map, not typed.

          These four are what every city-scoped query groups by, so a typo here
          does not just look wrong on this form — it splits a city in the
          attendee app's browse list, where each spelling finds half the events
          and neither looks like a mistake.

          The escape hatch is deliberately the pin rather than the text. If the
          resolved city is wrong the *pin* is wrong, and the pin is also what
          the geofence and the distance sort use — so typing over the symptom
          would leave check-in pointing at the wrong place while the form
          finally read correctly. Moving the pin fixes both.
        */}
        <DerivedField form={form} name="city" label="City" />
        <DerivedField form={form} name="state" label="State / Region" />
        <DerivedField form={form} name="country" label="Country" />
        <DerivedField form={form} name="postal_code" label="Postal Code" />
      </div>

      <p className="text-xs text-muted-foreground">
        City, region, country and postal code come from the map. Move the pin or
        redraw the area to change them.
      </p>

      {/* Hidden lat/lng — set by map */}
      <div className="grid grid-cols-2 gap-4 text-sm text-muted-foreground">
        <div>
          <span className="font-medium">Lat: </span>
          {form.watch("latitude")?.toFixed(6) ?? "—"}
        </div>
        <div>
          <span className="font-medium">Lng: </span>
          {form.watch("longitude")?.toFixed(6) ?? "—"}
        </div>
      </div>

      {/*
        The geofence, replacing a lone radius slider.

        One number could not serve both a 20m cafe and a 200m stadium, because
        it was doing three jobs at once — the venue's size, the organiser's
        tolerance, and slack for bad GPS. The editor shows those as three rings,
        and the third one is the point: once an organiser can see that GPS noise
        is handled for them, they stop drawing the shape "bigger to be safe".

        That is not hypothetical. A real football match on production carries a
        100km radius, which is someone working around exactly this.

        check_in_radius is still written for older mobile clients that read it;
        `geofence` is what the check-in route prefers.
      */}
      <FormField
        control={form.control}
        name="geofence"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Where check-in counts</FormLabel>
            <FormControl>
              <GeofenceEditor
                value={(field.value as Geofence | null) ?? null}
                onChange={(fence) => {
                  field.onChange(fence)
                  // Keep the legacy column roughly in step: mobile builds in
                  // the wild still read check_in_radius.
                  if (fence.type === "circle") {
                    form.setValue("check_in_radius", Math.round(fence.radius + fence.buffer))
                  }
                  /*
                    Drag the pin to the shape the organiser actually drew.

                    Nothing did this before, so an organiser could drop the pin
                    on their office, trace a stadium five kilometres away, and
                    save both. The fence was right — check-in worked — while
                    `latitude`/`longitude` still pointed at the office. Those
                    columns are what the attendee app sorts "Nearby" by and what
                    the map marker uses, so the event showed up at the wrong
                    distance from everyone, and nothing about the form looked
                    wrong.

                    `fenceCentre` returns null for a ring that is still being
                    drawn; leaving the pin alone until the shape exists is the
                    right behaviour, not a missed case.
                  */
                  const centre = fenceCentre(fence)
                  if (centre) {
                    form.setValue("latitude", centre.lat)
                    form.setValue("longitude", centre.lng)
                  }
                }}
                fallbackCentre={
                  form.watch("latitude") && form.watch("longitude")
                    ? { lat: form.watch("latitude")!, lng: form.watch("longitude")! }
                    : undefined
                }
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </FormSection>
  )
}

/**
 * A field the map fills in and the organiser reads.
 *
 * Still a real form field rather than plain text: it stays in the form state,
 * it submits, and it keeps its label — so screen readers and the existing
 * layout both behave as before. Only typing is off.
 *
 * `readOnly` rather than `disabled` on purpose. A disabled input is skipped by
 * keyboard navigation and, in most browsers, is not announced at all — so an
 * organiser using a screen reader would simply never hear the city their event
 * had been filed under.
 */
function DerivedField({
  form,
  name,
  label,
}: {
  form: UseFormReturn<EventFormValues>
  name: "city" | "state" | "country" | "postal_code"
  label: string
}) {
  return (
    <FormField
      control={form.control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input
              {...field}
              value={field.value ?? ""}
              readOnly
              tabIndex={-1}
              placeholder="From the map"
              className="bg-muted text-muted-foreground"
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  )
}
