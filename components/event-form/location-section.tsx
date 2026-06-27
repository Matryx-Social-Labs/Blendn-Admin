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
import { Slider } from "@/components/ui/slider"
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

      <FormField
        control={form.control}
        name="check_in_radius"
        render={({ field }) => (
          <FormItem>
            <FormLabel>
              Check-in Radius —{" "}
              <span className="font-normal text-muted-foreground">
                {field.value ?? 100} m
              </span>
            </FormLabel>
            <FormControl>
              <Slider
                min={10}
                max={5000}
                step={10}
                value={[field.value ?? 100]}
                onValueChange={(vals) => field.onChange(vals[0])}
              />
            </FormControl>
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>10 m</span>
              <span>5 000 m</span>
            </div>
            <FormMessage />
          </FormItem>
        )}
      />
    </FormSection>
  )
}
