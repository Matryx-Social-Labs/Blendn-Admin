"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import { SectionTitle } from "@/components/dashboard/primitives"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { restoreVenue, retireVenue, updateVenue } from "@/lib/venue-actions"

/**
 * The controls a venue record never had.
 *
 * `venues.status` and `venues.deleted_at` have existed since the table did, and
 * **nothing ever wrote either** — so a venue, once created, was permanent and
 * uneditable, which is the inverse of what a place is. `updateVenue` and
 * `assignVenueOwner` were both built, tested and reachable by nobody; this is
 * the screen the reachability ratchet has been asking for.
 *
 * Coordinates matter most. They were write-once at creation, and a venue's
 * wrong pin is wrong for every event ever held there rather than for one night
 * — and it never ages out, because a place has no end date.
 */
export function VenueManage({
  venue,
  isAdmin,
}: {
  venue: {
    id: string
    name: string
    venueType: string | null
    address: string | null
    city: string | null
    capacity: number | null
    lat: number | null
    lng: number | null
    retired: boolean
    ownerOrg: string | null
  }
  isAdmin: boolean
}) {
  const router = useRouter()
  const [pending, start] = useTransition()
  const [form, setForm] = useState({
    name: venue.name,
    address: venue.address ?? "",
    city: venue.city ?? "",
    capacity: venue.capacity?.toString() ?? "",
    lat: venue.lat?.toString() ?? "",
    lng: venue.lng?.toString() ?? "",
  })

  const field = (key: keyof typeof form) => ({
    id: key,
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value })),
  })

  const save = () =>
    start(async () => {
      try {
        /*
         * Both coordinates or neither, decided here as well as in the action.
         * The action refuses half a pair — this stops the round trip that would
         * only be told so afterwards.
         */
        const hasLat = form.lat.trim() !== ""
        const hasLng = form.lng.trim() !== ""
        if (hasLat !== hasLng) {
          toast.error("Give both a latitude and a longitude, or neither.")
          return
        }
        await updateVenue(venue.id, {
          name: form.name.trim(),
          address: form.address.trim() || null,
          city: form.city.trim() || null,
          capacity: form.capacity.trim() ? Number(form.capacity) : null,
          ...(hasLat ? { lat: Number(form.lat), lng: Number(form.lng) } : {}),
        })
        toast.success("Saved")
        router.refresh()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not save")
      }
    })

  const retire = () =>
    start(async () => {
      try {
        await retireVenue(venue.id)
        toast.success("Retired")
        router.refresh()
      } catch (error) {
        // The refusal names the reason — usually "events are still booked
        // here" — so it is shown rather than replaced with a generic failure.
        toast.error(error instanceof Error ? error.message : "Could not retire")
      }
    })

  const restore = () =>
    start(async () => {
      try {
        await restoreVenue(venue.id)
        toast.success("Restored")
        router.refresh()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not restore")
      }
    })

  return (
    <section className="flex flex-col gap-3">
      <SectionTitle hint={venue.ownerOrg ?? "unclaimed"}>Record</SectionTitle>

      <div className="grid gap-3 rounded-lg border border-border bg-card p-4 @2xl/main:grid-cols-3">
        <div className="flex flex-col gap-1.5 @2xl/main:col-span-3">
          <Label htmlFor="name">Name</Label>
          <Input {...field("name")} />
        </div>
        <div className="flex flex-col gap-1.5 @2xl/main:col-span-2">
          <Label htmlFor="address">Address</Label>
          <Input {...field("address")} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="city">City</Label>
          <Input {...field("city")} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="capacity">Capacity</Label>
          <Input {...field("capacity")} inputMode="numeric" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="lat">Latitude</Label>
          <Input {...field("lat")} inputMode="decimal" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="lng">Longitude</Label>
          <Input {...field("lng")} inputMode="decimal" />
        </div>

        <div className="flex flex-wrap items-center gap-2 @2xl/main:col-span-3">
          <Button size="sm" onClick={save} disabled={pending || venue.retired}>
            Save
          </Button>
          {venue.retired ? (
            isAdmin ? (
              <Button size="sm" variant="outline" onClick={restore} disabled={pending}>
                Restore
              </Button>
            ) : null
          ) : (
            <Button size="sm" variant="outline" onClick={retire} disabled={pending}>
              Retire
            </Button>
          )}
        </div>
      </div>
    </section>
  )
}
