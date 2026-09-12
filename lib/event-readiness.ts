import type { EventFormValues } from "@/components/event-form/schema"
import { validateGeofence } from "@/lib/geofence"

/**
 * What still stops this event being published, said before Save rather than
 * after.
 *
 * ## The gap this closes
 *
 * `canPublish()` in `lib/geofence-input.ts` refuses an event with no
 * coordinates and no fence, because the check-in route has nothing to compare
 * against — before that gate existed, such an event accepted check-ins **from
 * anywhere on earth**. The gate is right. The problem is where the organiser
 * meets it: they fill in a 5,683px form, press Create, and are refused by a
 * toast, having already scrolled past the section that would have fixed it.
 *
 * The form is the only place that knows this early, and it knew all along.
 *
 * ## Why blockers and warnings are different lists
 *
 * A blocker is the server refusing. A warning is something that will work and
 * probably should not — a fence so tight that people standing inside the venue
 * are outside it, a run with no end time. Collapsing the two would either cry
 * wolf or hide a refusal among advice, and the register has an example of each.
 */
/** The field an item points at: the id the form gives that field's anchor. */
export type ReadinessField =
  | "title"
  | "start_time"
  | "end_time"
  | "location"
  | "check_in_radius"
  | "timezone"
  | "category_ids"
  | "cover_image_url"

export interface ReadinessItem {
  message: string
  field: ReadinessField
}

export interface Readiness {
  /** Publishing is refused until every one of these is cleared. */
  blockers: ReadinessItem[]
  /** Publishing works. Somebody may still regret it. */
  warnings: ReadinessItem[]
}

/**
 * Metres. Below this, a GPS fix that is *inside* the building routinely reads
 * as outside it.
 *
 * Not a guess: `lib/geofence.ts` assumes 35m of accuracy when a device reports
 * none, so a radius under that is smaller than the error bar the server itself
 * works with. The zod floor is 10, which is submittable and unusable.
 */
export const TIGHT_FENCE_METRES = 50

export function eventReadiness(values: Partial<EventFormValues>): Readiness {
  const blockers: ReadinessItem[] = []
  const warnings: ReadinessItem[] = []
  const block = (field: ReadinessField, message: string) => blockers.push({ field, message })
  const warn = (field: ReadinessField, message: string) => warnings.push({ field, message })

  if (!values.title?.trim()) block("title", "Give the event a title.")
  if (!values.start_time) block("start_time", "Set a start time.")
  if (!values.end_time) block("end_time", "Set an end time.")

  /*
   * The `canPublish` rule, mirrored — deliberately, and the duplication is
   * argued for rather than tolerated.
   *
   * The server keeps its own copy because a form cannot be trusted and because
   * the mobile clone route creates events without touching this code at all.
   * What the form adds is the *timing*: the same answer, before the scroll
   * rather than after it. `__tests__/event-readiness.test.ts` holds the two in
   * step, so a change to one that is not made to the other fails the build.
   */
  const hasPin =
    typeof values.latitude === "number" && typeof values.longitude === "number"
  /*
   * VALIDATED, not merely present.
   *
   * This was `Boolean(values.geofence)`, and the difference is not academic:
   * `geofence-editor.tsx`'s `switchMode` writes
   * `{ type: "polygon", ring: [], buffer }` the instant somebody clicks the
   * polygon toggle, **before they have drawn anything**. That object is truthy,
   * so the strip flipped to "Ready to publish" while `validateGeofence`
   * returned `ring_too_short` and the server refused on Save.
   *
   * The strip exists to stop exactly that — being refused after the scroll — so
   * a looser rule than the server's turns it into the bug it was written to
   * prevent, and does it live, mid-session, rather than only at first load.
   *
   * `validateGeofence` is the server's own function and is pure, so this is the
   * same rule rather than a second one that has to be kept in step.
   */
  const hasFence = Boolean(values.geofence) && validateGeofence(values.geofence).ok
  if (!hasPin && !hasFence) {
    block(
      "location",
      "Drop a pin on the map. GPS check-in needs somewhere to check against, and the event cannot publish without it."
    )
  }

  /*
   * A radius that cannot be submitted, and says nothing about why.
   *
   * `check_in_radius` is DERIVED — `round(radius + buffer)` in
   * `location-section.tsx` — and zod's floor is 10, so a 5m radius with no
   * buffer produces 5, `handleSubmit` refuses, and **no `FormMessage` for this
   * field is rendered anywhere**. The organiser presses Save and nothing at all
   * happens. K1.4 in the register.
   */
  const radius = values.check_in_radius
  if (typeof radius === "number" && radius < 10) {
    block(
      "check_in_radius",
      `The check-in area is ${radius}m across, and the smallest allowed is 10m. Widen the circle or the buffer.`
    )
  } else if (typeof radius === "number" && radius < TIGHT_FENCE_METRES) {
    warn(
      "check_in_radius",
      `A ${radius}m check-in area is tighter than a typical GPS fix, so people standing inside may be turned away.`
    )
  }

  /*
   * Both are `datetime-local` STRINGS on the form, not Dates.
   *
   * `"2026-10-01T22:00" > "2026-10-01T18:00"` happens to be true because ISO
   * strings sort lexicographically — but only while both are well-formed and
   * the same length, which is exactly the kind of accident that survives review
   * and then breaks on a value with a seconds component. Parsed, and the parse
   * failing is itself not an error to report: the field's own required
   * validation already covers a blank one.
   */
  if (values.start_time && values.end_time) {
    const start = Date.parse(values.start_time)
    const end = Date.parse(values.end_time)
    if (!Number.isNaN(start) && !Number.isNaN(end) && end <= start) {
      block("end_time", "The event ends before it starts.")
    }
  }

  if (!values.timezone) {
    /*
     * A blocker, not a warning, and the reason is curation.
     *
     * The form used to store the ADMIN's browser timezone, so somebody in
     * London curating a Bengaluru event stored `Europe/London` — and
     * `events.timezone` is served to the mobile client, so attendees saw the
     * wrong local time. It then surfaced on the curation-health screen as
     * "ended with nobody in", misattributed to a dead listing by the very
     * screen built to catch a wrong pin.
     */
    block("timezone", "Choose the timezone the event happens in, not the one you are in.")
  }

  if (!values.category_ids?.length) {
    warn("category_ids", "No category, so this will not appear under any section in the app.")
  }

  if (!values.cover_image_url) {
    warn("cover_image_url", "No cover image — the card renders, but as a blank rectangle.")
  }

  return { blockers, warnings }
}
