"use client"

import { useCallback, useEffect, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconArrowRight,
  IconCheck,
  IconLoader2,
  IconMapPin,
  IconSearch,
} from "@tabler/icons-react"

import { GeofenceEditor } from "@/components/geofence-editor"
import { VenueTypePicker } from "@/components/venue-type-picker"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"
import { createVenue, venuesNear, type NearbyVenue } from "@/lib/venue-actions"
import { defaultExtentMetres, venueTypeLabel } from "@/lib/venue-types"
import type { Geofence } from "@/lib/geofence"
import type { venue_type } from "@prisma/client"

/**
 * Create a venue.
 *
 * Staged like the event editor, because the shape of the work is the same:
 * four things to say, each of which is easier once the last is settled. The
 * geofence in particular is far easier to draw *after* the pin is placed, and
 * meaningless before.
 *
 * The stage that matters is Location. `venuesNear` runs on every pin move, and
 * a hit **blocks Next** until the answer is claim-or-confirm. That is layer 1
 * of the four in `lib/venue-actions.ts`, and it is the only one a human sees.
 */

const STAGES = ["Basics", "Location", "Capacity", "Review"] as const
type Stage = (typeof STAGES)[number]

interface Draft {
  name: string
  venueType: venue_type | null
  address: string
  city: string
  lat: number | null
  lng: number | null
  capacity: string
  geofence: Geofence | null
}

export function VenueCreateForm({ canOwn }: { canOwn: boolean }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [stage, setStage] = useState<Stage>("Basics")
  const [draft, setDraft] = useState<Draft>({
    name: "",
    venueType: null,
    address: "",
    city: "",
    lat: null,
    lng: null,
    capacity: "",
    geofence: null,
  })

  const [nearby, setNearby] = useState<NearbyVenue[]>([])
  const [checking, setChecking] = useState(false)
  // Keyed on the pin, not a boolean: moving the pin invalidates the
  // acknowledgement without a reset that could race the next lookup.
  const [ackFor, setAckFor] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [searching, setSearching] = useState(false)

  const set = useCallback(<K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }))
  }, [])

  // Every pin move re-asks. A duplicate check that only ran on submit would
  // surface the answer after the geofence had been drawn, which is the
  // expensive part to throw away.
  useEffect(() => {
    if (draft.lat === null || draft.lng === null) return
    const lat = draft.lat
    const lng = draft.lng
    let cancelled = false
    const t = setTimeout(() => {
      if (cancelled) return
      setChecking(true)
      venuesNear(lat, lng)
        .then((hits) => {
          if (!cancelled) setNearby(hits)
        })
        .catch(() => {
          // A failed dedup check must not block creation — the server re-runs
          // it on submit, so this is an optimisation, not the gate.
          if (!cancelled) setNearby([])
        })
        .finally(() => {
          if (!cancelled) setChecking(false)
        })
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [draft.lat, draft.lng])

  // The pin seeds a circle sized for the type, so most venues never draw
  // anything. Derived rather than stored — an effect that writes it back would
  // fight the editor's own null handling.
  const fence: Geofence | null =
    draft.geofence ??
    (draft.lat !== null && draft.lng !== null
      ? {
          type: "circle",
          lat: draft.lat,
          lng: draft.lng,
          radius: defaultExtentMetres(draft.venueType),
          buffer: 20,
        }
      : null)

  async function search() {
    const q = query.trim()
    if (!q) return
    setSearching(true)
    try {
      const res = await fetch(
        `/api/geocode?q=${encodeURIComponent(q)}`
      )
      const hits = (await res.json()) as {
        lat: string
        lon: string
        display_name: string
        address?: Record<string, string>
      }[]
      if (!hits.length) {
        toast.error("Nothing found — drop the pin by hand instead.")
        return
      }
      const hit = hits[0]
      setDraft((d) => ({
        ...d,
        lat: Number(hit.lat),
        lng: Number(hit.lon),
        address: d.address || hit.display_name,
        city:
          d.city ||
          hit.address?.city ||
          hit.address?.town ||
          hit.address?.state_district ||
          "",
        geofence: null,
      }))
    } catch {
      toast.error("Search is unavailable. Drop the pin by hand.")
    } finally {
      setSearching(false)
    }
  }

  const pinKey = draft.lat !== null && draft.lng !== null ? `${draft.lat},${draft.lng}` : null
  const acknowledged = ackFor !== null && ackFor === pinKey
  const blockingDuplicate = nearby.length > 0 && !acknowledged
  const stageValid: Record<Stage, boolean> = {
    Basics: draft.name.trim().length >= 2 && draft.venueType !== null,
    Location: draft.lat !== null && draft.lng !== null && !checking && !blockingDuplicate,
    Capacity: true,
    Review: true,
  }

  const index = STAGES.indexOf(stage)

  function submit() {
    if (draft.lat === null || draft.lng === null) return
    startTransition(async () => {
      try {
        const { id } = await createVenue({
          name: draft.name,
          venueType: draft.venueType,
          address: draft.address || null,
          city: draft.city || null,
          lat: draft.lat!,
          lng: draft.lng!,
          capacity: draft.capacity ? Number(draft.capacity) : null,
          geofence: fence ?? undefined,
          acknowledgedDuplicates: acknowledged || nearby.length === 0,
        })
        toast.success(
          canOwn ? `${draft.name} added to your venues.` : `${draft.name} created, unclaimed.`
        )
        router.push(`/dashboard/venues/${id}`)
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not create the venue.")
      }
    })
  }

  return (
    <div className="flex flex-col gap-5">
      <ol className="flex flex-wrap items-center gap-1.5" aria-label="Progress">
        {STAGES.map((s, i) => {
          const done = i < index
          const current = s === stage
          return (
            <li key={s} className="flex items-center gap-1.5">
              <button
                type="button"
                // Backwards only. Forward is the validity gate's job.
                onClick={() => i < index && setStage(s)}
                disabled={i > index}
                aria-current={current ? "step" : undefined}
                className={cn(
                  "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[0.78125rem]",
                  current && "bg-surface-raised font-bold",
                  done && "text-muted-foreground",
                  i > index && "text-faint-foreground"
                )}
              >
                {done ? (
                  <IconCheck className="size-3.5 text-success" />
                ) : (
                  <span className="tabular-nums">{i + 1}</span>
                )}
                {s}
              </button>
              {i < STAGES.length - 1 ? (
                <span className="text-faint-foreground" aria-hidden>
                  /
                </span>
              ) : null}
            </li>
          )
        })}
      </ol>

      <div className="rounded-lg border border-border bg-card p-5">
        {stage === "Basics" ? (
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <Label htmlFor="venue-name">Venue name</Label>
              <Input
                id="venue-name"
                value={draft.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="Toit Brewpub"
                autoFocus
              />
              <p className="text-[0.75rem] text-faint-foreground">
                The name attendees would recognise, not the registered company name.
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Label>What kind of venue is it?</Label>
              <VenueTypePicker
                value={draft.venueType}
                onChange={(t) => set("venueType", t)}
              />
            </div>
          </div>
        ) : null}

        {stage === "Location" ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="venue-search">Find the building</Label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <IconSearch className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint-foreground" />
                  <Input
                    id="venue-search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault()
                        void search()
                      }
                    }}
                    placeholder="Toit, Indiranagar"
                    className="pl-8"
                  />
                </div>
                <Button type="button" variant="outline" onClick={() => void search()} disabled={searching}>
                  {searching ? <IconLoader2 className="size-4 animate-spin" /> : "Search"}
                </Button>
              </div>
            </div>

            <GeofenceEditor
              value={fence}
              onChange={(fence) => {
                set("geofence", fence)
                // The pin follows a circle's centre, so the venue coordinates
                // and the fence cannot drift apart.
                if (fence.type === "circle") {
                  setDraft((d) => ({ ...d, lat: fence.lat, lng: fence.lng }))
                }
              }}
              fallbackCentre={
                draft.lat !== null && draft.lng !== null
                  ? { lat: draft.lat, lng: draft.lng }
                  : undefined
              }
            />

            {draft.lat === null ? (
              <p className="flex items-center gap-2 text-[0.78125rem] text-muted-foreground">
                <IconMapPin className="size-4" />
                Search above, or click the map to place the venue.
              </p>
            ) : null}

            {checking ? (
              <p className="flex items-center gap-2 text-[0.78125rem] text-muted-foreground">
                <IconLoader2 className="size-3.5 animate-spin" />
                Checking what is already listed here…
              </p>
            ) : null}

            {nearby.length > 0 ? (
              <div className="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning/5 p-4">
                <p className="flex items-center gap-2 text-[0.8125rem] font-bold">
                  <IconAlertTriangle className="size-4 text-warning" />
                  {nearby.length === 1
                    ? "A venue is already listed here"
                    : `${nearby.length} venues are already listed here`}
                </p>
                <ul className="flex flex-col gap-2">
                  {nearby.map((v) => (
                    <li
                      key={v.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-card px-3 py-2"
                    >
                      <span className="flex flex-col">
                        <b className="text-[0.8125rem] font-bold">{v.name}</b>
                        <span className="text-[0.75rem] text-faint-foreground">
                          {v.distanceMetres} m away
                          {v.address ? ` · ${v.address}` : ""}
                        </span>
                      </span>
                      {v.claimed ? (
                        <Badge variant="secondary">Already claimed</Badge>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => router.push(`/dashboard/venues/${v.id}/claim`)}
                        >
                          Claim this instead
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
                <label className="flex items-start gap-2.5 text-[0.78125rem]">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(e) => setAckFor(e.target.checked ? pinKey : null)}
                    className="mt-0.5 size-4 accent-[var(--color-primary)]"
                  />
                  <span>
                    This is a different place — a separate hall or a distinct venue at the same
                    address.
                  </span>
                </label>
              </div>
            ) : null}
          </div>
        ) : null}

        {stage === "Capacity" ? (
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <Label htmlFor="venue-capacity">Capacity</Label>
              <Input
                id="venue-capacity"
                type="number"
                min={1}
                inputMode="numeric"
                value={draft.capacity}
                onChange={(e) => set("capacity", e.target.value)}
                placeholder="Optional"
                className="max-w-[12rem]"
              />
              <p className="text-[0.75rem] text-faint-foreground">
                The room&rsquo;s maximum. Events here prefill from it and warn when they exceed
                it — they are never blocked, since a seated layout legitimately holds fewer.
              </p>
            </div>
            <div className="grid gap-4 @2xl/main:grid-cols-2">
              <div className="flex flex-col gap-2">
                <Label htmlFor="venue-address">Address</Label>
                <Input
                  id="venue-address"
                  value={draft.address}
                  onChange={(e) => set("address", e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="venue-city">City</Label>
                <Input
                  id="venue-city"
                  value={draft.city}
                  onChange={(e) => set("city", e.target.value)}
                />
              </div>
            </div>
          </div>
        ) : null}

        {stage === "Review" ? (
          <dl className="flex flex-col gap-3 text-[0.8125rem]">
            <Row label="Name" value={draft.name} />
            <Row label="Type" value={venueTypeLabel(draft.venueType)} />
            <Row label="Address" value={[draft.address, draft.city].filter(Boolean).join(", ") || "—"} />
            <Row
              label="Check-in area"
              value={
                fence?.type === "polygon"
                  ? `Traced outline, ${fence.ring.length} points, +${fence.buffer} m buffer`
                  : fence
                    ? `${fence.radius} m circle, +${fence.buffer} m buffer`
                    : "—"
              }
            />
            <Row label="Capacity" value={draft.capacity || "Not set"} />
            <Row
              label="Ownership"
              value={
                canOwn
                  ? "Owned by your organisation from creation"
                  : "Unclaimed — a venue owner can claim it"
              }
            />
            <p className="mt-1 text-[0.75rem] text-faint-foreground">
              Events held here inherit the location, capacity and check-in area. Each of those
              stays overridable per event.
            </p>
          </dl>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-3">
        <Button
          type="button"
          variant="ghost"
          onClick={() => (index === 0 ? router.back() : setStage(STAGES[index - 1]))}
        >
          <IconArrowLeft className="size-4" />
          {index === 0 ? "Cancel" : STAGES[index - 1]}
        </Button>

        {stage === "Review" ? (
          <Button type="button" onClick={submit} disabled={pending}>
            {pending ? <IconLoader2 className="size-4 animate-spin" /> : null}
            Create venue
          </Button>
        ) : (
          <Button
            type="button"
            onClick={() => setStage(STAGES[index + 1])}
            disabled={!stageValid[stage]}
          >
            {blockingDuplicate ? "Answer the duplicate check first" : STAGES[index + 1]}
            <IconArrowRight className="size-4" />
          </Button>
        )}
      </div>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap justify-between gap-2 border-b border-border pb-2 last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  )
}
