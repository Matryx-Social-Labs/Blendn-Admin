"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"

import type { venue_type } from "@prisma/client"

import { Panel } from "@/components/dashboard/kit"
import { VenueArea } from "@/components/venue-area"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { assignVenueOwner, restoreVenue, retireVenue, updateVenue } from "@/lib/venue-actions"
import { validateGeofence, type Geofence } from "@/lib/geofence"
import { refusalMessage } from "@/lib/refusal"
import { floorsHeightMetres } from "@/lib/venue-floors"
import { followType, VENUE_TYPE_GROUPS } from "@/lib/venue-types"

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
 *
 * The check-in area was write-once for the same reason and for longer: the
 * editor lived only in the create wizard, so a fence drawn in the wrong place
 * could be corrected by nobody (SCRUM-204). It decides who gets through the
 * door at every event here, which makes it the least forgivable field on the
 * page to leave unwritable.
 *
 * Since SCRUM-354 the place is found, not typed: one search, its outline
 * arriving on its own, the buffer labelled as the default every event here
 * starts with — the event form's flow. The latitude and longitude boxes went:
 * the pin is the area's centre, so the two cannot drift apart (SCRUM-204).
 */
export function VenueManage({
  venue,
  isAdmin,
  orgs,
  canRetire = true,
}: {
  venue: {
    id: string
    name: string
    venueType: venue_type | null
    address: string | null
    city: string | null
    capacity: number | null
    lat: number | null
    lng: number | null
    /** Whatever is stored. Unparseable rows are shown as "none yet". */
    geofence: unknown
    retired: boolean
    ownerOrg: string | null
    floors: number | null
  }
  isAdmin: boolean
  /** Owner candidates. Empty for a non-admin, and for an already-owned venue. */
  orgs: { rows: { id: string; name: string }[]; total: number }
  /**
   * False for the organisation that added an unclaimed venue (SCRUM-361): it
   * may correct the place, not remove it from under other organisers' events.
   */
  canRetire?: boolean
}) {
  // The owner's organisation or an admin (`updateVenue` refuses anyone else):
  // the organisation that added an unclaimed venue corrects the place, not
  // how tall the app's map draws it.
  const canSetFloors = isAdmin || venue.ownerOrg !== null
  const router = useRouter()
  const [pending, start] = useTransition()
  const [org, setOrg] = useState("")
  const parsed = validateGeofence(venue.geofence)
  const [fence, setFence] = useState<Geofence | null>(parsed.ok ? parsed.fence : null)
  const [form, setForm] = useState({
    name: venue.name,
    address: venue.address ?? "",
    city: venue.city ?? "",
    capacity: venue.capacity?.toString() ?? "",
    floors: venue.floors?.toString() ?? "",
  })
  const [venueType, setVenueType] = useState<venue_type | null>(venue.venueType)
  /** The area's centre once the area changes; the stored pin until then. */
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(
    venue.lat !== null && venue.lng !== null ? { lat: venue.lat, lng: venue.lng } : null
  )
  const [moved, setMoved] = useState(false)

  const field = (key: keyof typeof form) => ({
    id: key,
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value })),
  })

  const save = () =>
    start(async () => {
      try {
        await updateVenue(venue.id, {
          name: form.name.trim(),
          venueType,
          address: form.address.trim() || null,
          city: form.city.trim() || null,
          capacity: form.capacity.trim() ? Number(form.capacity) : null,
          ...(canSetFloors ? { floors: form.floors.trim() ? Number(form.floors) : null } : {}),
          // The pin moves only with the area, as its centre — both at once.
          ...(moved && pin ? { lat: pin.lat, lng: pin.lng } : {}),
          // Always the area on screen, touched or not — so a venue whose
          // stored area has drifted from its pin cannot be saved around, even
          // for a rename, until the area is put back (SCRUM-204).
          ...(fence ? { geofence: fence } : {}),
        })
        toast.success("Saved")
        router.refresh()
      } catch (error) {
        toast.error(refusalMessage(error, "Could not save"))
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
        toast.error(refusalMessage(error, "Could not retire"))
      }
    })

  const restore = () =>
    start(async () => {
      try {
        await restoreVenue(venue.id)
        toast.success("Restored")
        router.refresh()
      } catch (error) {
        toast.error(refusalMessage(error, "Could not restore"))
      }
    })

  const assign = () =>
    start(async () => {
      try {
        await assignVenueOwner(venue.id, org)
        toast.success("Owner assigned")
        router.refresh()
      } catch (error) {
        // Re-assigning an owned venue is refused by the action — that is a
        // dispute, and a dispute has a person in it.
        toast.error(refusalMessage(error, "Could not assign"))
      }
    })

  return (
    <Panel title="Venue record" hint="events here inherit its pin, capacity and check-in area">
      <div className="grid gap-3 @2xl/main:grid-cols-5">
        <div className="flex flex-col gap-1.5 @2xl/main:col-span-2">
          <Label htmlFor="name">Name</Label>
          <Input {...field("name")} disabled={venue.retired} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="venue-type">Type</Label>
          <select
            id="venue-type"
            value={venueType ?? ""}
            onChange={(e) => {
              const next = (e.target.value || null) as venue_type | null
              setFence((f) => followType(f, venueType, next))
              setVenueType(next)
            }}
            disabled={venue.retired}
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
          >
            <option value="">Unclassified</option>
            {VENUE_TYPE_GROUPS.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.types.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="capacity">Capacity</Label>
          <Input {...field("capacity")} inputMode="numeric" disabled={venue.retired} />
        </div>
        {canSetFloors ? <FloorsField {...field("floors")} disabled={venue.retired} /> : null}

        <div className="flex flex-col gap-1.5 @2xl/main:col-span-5">
          <VenueArea
            fence={fence}
            venueType={venueType}
            editable={!venue.retired}
            fallbackCentre={pin ?? undefined}
            onPlace={({ location }) =>
              setForm((f) => ({ ...f, address: location.address, city: location.city ?? f.city }))
            }
            onArea={(next, centre) => {
              setFence(next)
              if (centre) {
                setPin(centre)
                setMoved(true)
              }
            }}
            caption={
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="address" className="sr-only">
                  Address
                </Label>
                <Input
                  {...field("address")}
                  disabled={venue.retired}
                  placeholder="The address — written by the place; edit if the street is wrong"
                />
                <p className="text-[0.8125rem] text-muted-foreground">
                  {form.city ? (
                    <>
                      <span className="text-foreground">{form.city}</span> — from the place
                    </>
                  ) : (
                    "The city comes from the place."
                  )}
                </p>
              </div>
            }
          />
        </div>

        {/*
          Assigning an owner is the admin-side counterpart to a claim, for when
          ownership is settled over email rather than through the queue. Only
          for an unclaimed venue: re-assigning an owned one is a dispute, and
          the action refuses it.
        */}
        {isAdmin && !venue.ownerOrg && !venue.retired ? (
          <div className="flex flex-col gap-1.5 @2xl/main:col-span-5">
            <Label htmlFor="owner">Owner</Label>
            <div className="flex flex-wrap items-center gap-2">
              <select
                id="owner"
                value={org}
                onChange={(e) => setOrg(e.target.value)}
                className="h-9 min-w-56 rounded-md border border-input bg-transparent px-3 text-sm"
              >
                <option value="">Choose an organisation…</option>
                {orgs.rows.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
              <Button size="sm" variant="outline" onClick={assign} disabled={pending || !org}>
                Assign
              </Button>
              {orgs.total > orgs.rows.length ? (
                <span className="text-[0.75rem] text-muted-foreground">
                  Showing {orgs.rows.length} of {orgs.total}.
                </span>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2 @2xl/main:col-span-5">
          <Button size="sm" onClick={save} disabled={pending || venue.retired}>
            Save
          </Button>
          {venue.retired ? (
            isAdmin ? (
              <Button size="sm" variant="outline" onClick={restore} disabled={pending}>
                Restore
              </Button>
            ) : null
          ) : canRetire ? (
            <Button size="sm" variant="outline" onClick={retire} disabled={pending}>
              Retire
            </Button>
          ) : null}
        </div>
      </div>
    </Panel>
  )
}

/**
 * The building's floors, answered in the app's terms: how tall its 3D map
 * will draw the venue. Empty leaves the map's own height.
 */
function FloorsField(props: React.ComponentProps<typeof Input> & { value: string }) {
  const n = Number(props.value)
  const valid = props.value.trim() !== "" && Number.isInteger(n) && n >= 1 && n <= 200
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="floors">Floors</Label>
      <Input {...props} id="floors" inputMode="numeric" placeholder="From the map" aria-describedby="floors-hint" />
      <p id="floors-hint" aria-live="polite" className="text-[0.75rem] text-faint-foreground">
        {valid
          ? `The app's map draws this building about ${floorsHeightMetres(n)} m tall.`
          : props.value.trim()
            ? "A whole number from 1 to 200."
            : "Empty: the app's map uses its own height."}
      </p>
    </div>
  )
}
