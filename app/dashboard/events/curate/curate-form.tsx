"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { IconMapPin } from "@tabler/icons-react"
import { toast } from "sonner"

import { LocationPicker, type LocationData } from "@/components/location-picker"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { CURATED_RADIUS_METRES, CURATED_BUFFER_METRES } from "@/lib/curation"

import { curateEvent } from "./actions"

/**
 * Add an event we found.
 *
 * ## The map is the form's centre, not a field on it
 *
 * §5c: a curated pin is placed by somebody who has never stood there, so the
 * admin **confirms it on a map** before publish rather than pasting
 * coordinates. `canPublish` refuses a publish without one, so this is the step
 * that cannot be skipped rather than the one most likely to be.
 *
 * The same `LocationPicker` the event form uses. Not a second map: K1.1 found
 * two maps in one section disagreeing with each other, and a third would be a
 * third answer to "where is this".
 *
 * ## What this form does not ask for
 *
 * No cover image and no description. Decision 2 forbids reproducing a listing's
 * prose or images, and the description is generated server-side from the facts
 * entered here — so there is no field to fill in wrongly, which is a stronger
 * guarantee than a rule somebody has to remember.
 */
export function CurateForm({ defaultCity }: { defaultCity?: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [location, setLocation] = useState<LocationData | null>(null)
  const [form, setForm] = useState({
    title: "",
    source_url: "",
    start_time: "",
    end_time: "",
    venue_name: "",
    city: defaultCity ?? "",
  })

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }))

  const submit = () => {
    if (!location) {
      toast.error("Put the pin on the map first — check-in has nothing to check against without it")
      return
    }
    startTransition(async () => {
      const result = await curateEvent({
        title: form.title,
        latitude: location.lat,
        longitude: location.lng,
        venue_name: form.venue_name.trim() || null,
        address: location.address || null,
        // The geocoder's city wins over the typed one: it is what the feed will
        // filter on, and a typed "bangalore" against a geocoded "Bengaluru"
        // makes the event invisible in its own city.
        city: location.city ?? form.city,
        start_time: new Date(form.start_time).toISOString(),
        end_time: new Date(form.end_time).toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        source_url: form.source_url.trim(),
      })

      if (!result.ok) {
        toast.error(result.error)
        return
      }
      toast.success("Added, and published")
      router.push(`/dashboard/events/${result.eventId}`)
    })
  }

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-bold">Add an event we found</h3>
        <p className="text-[0.75rem] leading-5 text-muted-foreground">
          Facts only — the description is written from them. We never copy a
          listing&rsquo;s words or its image, and the source link is what a
          claimant is later verified against.
        </p>
      </div>

      <div className="grid gap-3 @2xl/main:grid-cols-2">
        <Field label="Title" required>
          <Input value={form.title} onChange={set("title")} placeholder="Friday Sessions" />
        </Field>
        <Field label="Source listing" required hint="Where we found it. Not editable later.">
          <Input
            value={form.source_url}
            onChange={set("source_url")}
            placeholder="https://…"
            type="url"
          />
        </Field>
        <Field label="Starts" required>
          <Input value={form.start_time} onChange={set("start_time")} type="datetime-local" />
        </Field>
        <Field label="Ends" required>
          <Input value={form.end_time} onChange={set("end_time")} type="datetime-local" />
        </Field>
        <Field label="Venue name">
          <Input value={form.venue_name} onChange={set("venue_name")} placeholder="The Humming Tree" />
        </Field>
        <Field label="City" hint="Filled from the map when you drop the pin.">
          <Input value={location?.city ?? form.city} onChange={set("city")} />
        </Field>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label className="text-[0.8125rem]">
          Where is it <span className="text-destructive">*</span>
        </Label>
        <p className="text-[0.75rem] text-muted-foreground">
          Drop the pin where the door is. A curated fence is deliberately
          generous — {CURATED_RADIUS_METRES}m plus {CURATED_BUFFER_METRES}m of
          buffer — because turning away somebody standing inside costs far more
          than admitting the café next door.
        </p>
        <LocationPicker checkInRadius={CURATED_RADIUS_METRES} onLocationChange={setLocation} />
        {location ? (
          <p className="inline-flex items-center gap-1.5 text-[0.75rem] text-muted-foreground">
            <IconMapPin className="size-3.5" />
            {location.address || `${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}`}
          </p>
        ) : null}
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={submit} disabled={pending}>
          {pending ? "Adding…" : "Add and publish"}
        </Button>
        <span className="text-[0.75rem] text-faint-foreground">
          Published immediately — an unpublished curated event is the state the
          city is already in.
        </span>
      </div>
    </div>
  )
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string
  required?: boolean
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-[0.8125rem]">
        {label}
        {required ? <span className="text-destructive"> *</span> : null}
      </Label>
      {children}
      {hint ? <span className="text-[0.75rem] text-faint-foreground">{hint}</span> : null}
    </div>
  )
}
