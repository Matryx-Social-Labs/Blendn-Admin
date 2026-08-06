"use client"

import type { UseFormReturn } from "react-hook-form"
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { GeofenceEditor } from "@/components/geofence-editor"
import type { Geofence } from "@/lib/geofence"
import { LocationPicker, type LocationData } from "@/components/location-picker"
import { FormSection } from "@/components/event-form/form-section"
import type { EventFormValues } from "@/components/event-form/schema"

export function LocationSection({
  form,
  onLocationChange,
}: {
  form: UseFormReturn<EventFormValues>
  onLocationChange: (data: LocationData) => void
}) {
  const checkInRadius = form.watch("check_in_radius") ?? 100
  const initialLat = form.getValues("latitude")
  const initialLng = form.getValues("longitude")

  return (
    <FormSection title="Location">
      <FormField
        control={form.control}
        name="venue_name"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Venue Name</FormLabel>
            <FormControl>
              <Input placeholder="Venue or venue name" {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

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
        <FormField
          control={form.control}
          name="city"
          render={({ field }) => (
            <FormItem>
              <FormLabel>City</FormLabel>
              <FormControl>
                <Input placeholder="City" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="state"
          render={({ field }) => (
            <FormItem>
              <FormLabel>State / Region</FormLabel>
              <FormControl>
                <Input placeholder="State" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="country"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Country</FormLabel>
              <FormControl>
                <Input placeholder="Country" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="postal_code"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Postal Code</FormLabel>
              <FormControl>
                <Input placeholder="Postal code" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>

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
