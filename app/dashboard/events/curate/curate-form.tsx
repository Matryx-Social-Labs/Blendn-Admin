"use client"

import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { IconMapPin } from "@tabler/icons-react"
import { toast } from "sonner"

import { LocationPicker, type LocationData } from "@/components/location-picker"
import { TimezoneSelect } from "@/components/event-form/timezone-select"
import { Button } from "@/components/ui/button"
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
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
 * ## Built on the repo's form primitives, after a first draft was not
 *
 * The first version hand-rolled a `Field` wrapper. `FormLabel`/`FormControl`
 * bind a label to its input, `FormMessage` renders a per-field error, and
 * `aria-invalid` follows from both — none of which a hand-rolled wrapper does.
 * So a screen-reader user got six unlabelled inputs, and everybody else got
 * zod's `String must contain at least 3 character(s)` in a toast, after a
 * round trip.
 *
 * ## What this form does not ask for
 *
 * No cover image and no description. Decision 2 forbids reproducing a listing's
 * prose or images, and the description is generated server-side from the facts
 * entered here — so there is no field to fill in wrongly, which is a stronger
 * guarantee than a rule somebody has to remember.
 */
const formSchema = z
  .object({
    title: z.string().trim().min(3, "Give it the title on the listing.").max(200),
    source_url: z.string().url("Paste the full listing URL, including https://"),
    start_time: z.string().min(1, "When does it start?"),
    end_time: z.string().min(1, "When does it end?"),
    /**
     * The event's timezone, not the browser's.
     *
     * This was `Intl.DateTimeFormat().resolvedOptions().timeZone` — the
     * ADMIN's timezone. Curation's whole premise is somebody adding events in
     * cities they are not in, so an admin in London curating a Bengaluru event
     * stored `Europe/London`. `events.timezone` is served to the mobile client
     * on the detail payload, so attendees saw the wrong local time — and it
     * would then surface on the curation-health screen as "nobody came",
     * misattributed to a dead listing by the very screen built to catch it.
     */
    timezone: z.string().min(1, "Pick the timezone the event happens in."),
    venue_name: z.string().trim().max(200).optional(),
  })
  .refine((v) => new Date(v.end_time) > new Date(v.start_time), {
    message: "It has to end after it starts.",
    path: ["end_time"],
  })

type FormValues = z.infer<typeof formSchema>

export function CurateForm({ defaultCity }: { defaultCity?: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [location, setLocation] = useState<LocationData | null>(null)
  const [pinError, setPinError] = useState<string | null>(null)

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      title: "",
      source_url: "",
      start_time: "",
      end_time: "",
      /*
       * Seeded from the browser as a convenience, not used as the answer. The
       * field is visible and required, so an admin curating elsewhere has to
       * look at it — which is the whole point of it being a field.
       */
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      venue_name: "",
    },
  })

  const submit = (values: FormValues) => {
    if (!location) {
      // Surfaced where the missing thing is, not as a toast at the top.
      setPinError("Put the pin on the map — check-in has nothing to check against without it.")
      return
    }
    setPinError(null)

    startTransition(async () => {
      const result = await curateEvent({
        title: values.title,
        latitude: location.lat,
        longitude: location.lng,
        venue_name: values.venue_name?.trim() || null,
        address: location.address || null,
        // The geocoder's city wins over anything typed: it is what the feed
        // filters on, and a typed "bangalore" against a geocoded "Bengaluru"
        // makes the event invisible in its own city.
        city: location.city ?? defaultCity ?? "",
        start_time: new Date(values.start_time).toISOString(),
        end_time: new Date(values.end_time).toISOString(),
        timezone: values.timezone,
        source_url: values.source_url.trim(),
      })

      if (!result.ok) {
        toast.error(result.error)
        return
      }

      /*
       * Stay here, and say what is left.
       *
       * The first version redirected to the event detail page, which ends the
       * loop -- but the demand row that sent you here said twenty-five people
       * are waiting in this city, and one event does not fix that. The natural
       * next action is another one for the same city, so the form resets, the
       * timezone and city stay in scope, and the new row appears in the queue
       * below.
       */
      toast.success("Added and published. Add another for this city?")
      form.reset({ ...form.getValues(), title: "", source_url: "", start_time: "", end_time: "", venue_name: "" })
      setLocation(null)
      router.refresh()
    })
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(submit)}
        className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4"
      >
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-bold">Add an event we found</h3>
          <p className="text-[0.75rem] leading-5 text-muted-foreground">
            Facts only — the description is written from them. We never copy a
            listing&rsquo;s words or its image, and the source link is what a
            claimant is later verified against.
          </p>
        </div>

        <div className="grid gap-3 @2xl/main:grid-cols-2">
          <FormField
            control={form.control}
            name="title"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Title</FormLabel>
                <FormControl>
                  <Input placeholder="Friday Sessions" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="source_url"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Source listing</FormLabel>
                <FormControl>
                  <Input type="url" placeholder="https://…" {...field} />
                </FormControl>
                <FormDescription>
                  Where we found it. Not editable later — a claim is verified
                  against it.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="start_time"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Starts</FormLabel>
                <FormControl>
                  <Input type="datetime-local" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="end_time"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Ends</FormLabel>
                <FormControl>
                  <Input type="datetime-local" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="timezone"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Timezone</FormLabel>
                <FormControl>
                  <TimezoneSelect value={field.value} onChange={field.onChange} />
                </FormControl>
                <FormDescription>
                  The event&rsquo;s, not yours. Seeded from this browser, so
                  check it when curating another city.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="venue_name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Venue name</FormLabel>
                <FormControl>
                  <Input placeholder="The Humming Tree" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="curate-map">
            Where is it <span className="text-destructive">*</span>
          </Label>
          <p className="text-[0.75rem] text-muted-foreground">
            Drop the pin where the door is. A curated fence is deliberately
            generous — {CURATED_RADIUS_METRES}m plus {CURATED_BUFFER_METRES}m of
            buffer — because turning away somebody standing inside costs far
            more than admitting the café next door.
          </p>
          <div id="curate-map">
            <LocationPicker
              checkInRadius={CURATED_RADIUS_METRES}
              onLocationChange={(l) => {
                setLocation(l)
                setPinError(null)
              }}
            />
          </div>
          {location ? (
            <p className="inline-flex items-center gap-1.5 text-[0.75rem] text-muted-foreground">
              <IconMapPin className="size-3.5" />
              {location.address || `${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}`}
              {location.city ? ` · ${location.city}` : ""}
            </p>
          ) : null}
          {pinError ? (
            <p role="alert" className="text-[0.8125rem] text-destructive">
              {pinError}
            </p>
          ) : null}
        </div>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={pending}>
            {pending ? "Adding…" : "Add and publish"}
          </Button>
          <span className="text-[0.75rem] text-faint-foreground">
            Published immediately — an unpublished curated event is the state
            the city is already in.
          </span>
        </div>
      </form>
    </Form>
  )
}
